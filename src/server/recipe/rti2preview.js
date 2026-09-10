#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const puppeteer = require('puppeteer-core')
const JSZip = require('jszip')
const { readExecutionInfo } = require('./readExecutionInfo')

const ROOT_PAGE_URL = 'https://ubhd-rti-preview.local/'
const VENDOR_VIRTUAL_BASE = `${ROOT_PAGE_URL}vendor/`
const ASSET_VIRTUAL_BASE = `${ROOT_PAGE_URL}asset/`
const RTI_MODE = 'diffuse'
const DEFAULT_VIEWPORT = { width: 1024, height: 768 }
const MAX_VIEWPORT_DIMENSION = 1200

// Erzeugt aus einem RTI-Web-Paket (info.json + Plane-Bilder, als ZIP) ein Vorschaubild, indem
// derselbe OpenLIME-Renderer wie im Viewer headless gerendert wird (Modus "diffuse" - laut Nutzer-
// Test im Viewer-"Layers"-Menue die korrekt belichtete Darstellung, robuster als ein einzelnes
// Plane-Bild oder ein selbst geratener Licht-Winkel).
async function main() {
	const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

	if (!infoArg || !inputFile || !outputFile) {
		throw new Error('Usage: node rti2preview.js <info-json-or-path> <source-url> <input-zip> <output-file>')
	}

	readExecutionInfo(infoArg)
	ensureReadableFile(inputFile, 'input RTI zip')

	const inputPath = path.resolve(inputFile)
	const outputPath = path.resolve(outputFile)

	const zip = await JSZip.loadAsync(await fsp.readFile(inputPath))
	const prefix = findInfoJsonPrefix(zip, path.basename(inputPath))
	const extractDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rti2preview-'))

	try {
		await extractZipEntries(zip, prefix, extractDir)

		const vendorDir = resolveVendorDir()
		const executablePath = await resolveBrowserExecutablePath()

		if (!executablePath) {
			throw new Error('No Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH or CHROME_BIN.')
		}

		const viewport = await resolveViewport(extractDir)
		const html = buildHtml()

		const browser = await puppeteer.launch({
			headless: process.env.VISIBLE ? false : 'new',
			executablePath,
			args: [
				'--disable-dev-shm-usage',
				'--disable-gpu',
				'--disable-setuid-sandbox',
				'--hide-scrollbars',
				'--no-sandbox',
				'--no-zygote',
				'--use-angle=swiftshader',
				'--use-gl=swiftshader'
			]
		})

		let page

		try {
			page = await browser.newPage()
			await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
			await page.setRequestInterception(true)

			// Alle Konsolenausgaben (nicht nur type==='error') mitschneiden: OpenLIME faengt manche
			// Initialisierungsfehler intern per console.log ab und haengt danach einfach - ohne das,
			// waere ein solcher Fall nur als nichtssagender Timeout sichtbar.
			const consoleLines = []
			page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`))
			page.on('error', (error) => consoleLines.push(`[error] ${error.message}`))
			page.on('console', (message) => consoleLines.push(`[console:${message.type()}] ${message.text()}`))
			page.on('requestfailed', (request) => consoleLines.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText || ''}`))
			page.on('request', (request) => {
				void handleRequest(request, { extractDir, vendorDir, html })
			})

			await page.goto(ROOT_PAGE_URL, { waitUntil: 'domcontentloaded' })

			try {
				await page.waitForFunction(() => window.__rtiReady === true || !!window.__rtiError, {
					timeout: Number(process.env.UBHD_PREVIEW_TIMEOUT_MS || 30000)
				})
			} catch (waitError) {
				const detail = consoleLines.length ? `\n${consoleLines.join('\n')}` : ''
				throw new Error(`RTI viewer never became ready (${waitError.message}).${detail}`)
			}

			const viewerError = await page.evaluate(() => window.__rtiError || null)
			if (viewerError) {
				const detail = consoleLines.length ? `\n${consoleLines.join('\n')}` : ''
				throw new Error(`${viewerError}${detail}`)
			}

			await new Promise((resolve) => setTimeout(resolve, 300))
			await fsp.mkdir(path.dirname(outputPath), { recursive: true })
			await page.screenshot({ path: outputPath, type: 'jpeg', quality: 88 })

			const outputStat = await fsp.stat(outputPath)
			if (!outputStat.size) {
				throw new Error(`Screenshot written but file is empty: ${outputPath}`)
			}

			console.error(`[rti2preview] Rendered ${sourceUrl || inputFile} (mode=${RTI_MODE}) -> ${outputPath}`)
		} finally {
			if (page) {
				await page.close().catch(() => {})
			}

			await browser.close().catch(() => {})
		}
	} finally {
		await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {})
	}
}

// Sucht das info.json-Verzeichnis im ZIP: Wurzel, dann Unterordner nach dem Zip-Namen,
// zuletzt eine Tiefensuche. Analog zur gleichnamigen Logik in rti-dist/index.html.
function findInfoJsonPrefix(zip, zipFilename) {
	if (zip.file('info.json')) {
		return ''
	}

	const sub = zipFilename.replace(/\.(rti|unpack)\.zip$/i, '')
	if (zip.file(sub + '/info.json')) {
		return sub + '/'
	}

	let prefix = ''
	zip.forEach((relativePath) => {
		if (!prefix && /(?:^|\/)info\.json$/.test(relativePath)) {
			prefix = relativePath.slice(0, relativePath.lastIndexOf('/') + 1)
		}
	})

	if (!zip.file(prefix + 'info.json')) {
		throw new Error('info.json not found in RTI zip.')
	}

	return prefix
}

// Schreibt alle Dateien unterhalb des info.json-Verzeichnisses (relativ, ohne Praefix) in destDir,
// damit puppeteer sie anschliessend per virtueller URL wie eine normale Web-RTI-Auslieferung bedienen kann.
async function extractZipEntries(zip, prefix, destDir) {
	const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith(prefix))

	await Promise.all(
		entries.map(async (entry) => {
			const rel = entry.name.slice(prefix.length)
			if (!rel) {
				return
			}

			const destPath = path.join(destDir, rel)
			await fsp.mkdir(path.dirname(destPath), { recursive: true })
			await fsp.writeFile(destPath, await entry.async('nodebuffer'))
		})
	)
}

// Liest optional width/height aus info.json, um den Screenshot-Viewport im selben Seitenverhaeltnis
// wie das RTI-Bild zu rendern (weniger Letterboxing). Ohne verwertbare Werte wird DEFAULT_VIEWPORT verwendet.
async function resolveViewport(extractDir) {
	try {
		const info = JSON.parse(await fsp.readFile(path.join(extractDir, 'info.json'), 'utf8'))
		const width = Number(info.width)
		const height = Number(info.height)

		if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
			const scale = MAX_VIEWPORT_DIMENSION / Math.max(width, height)
			return {
				width: Math.max(1, Math.round(width * Math.min(scale, 1))),
				height: Math.max(1, Math.round(height * Math.min(scale, 1)))
			}
		}
	} catch (_error) {
		// info.json ohne verwertbare width/height - DEFAULT_VIEWPORT verwenden
	}

	return DEFAULT_VIEWPORT
}

// Findet den lokal synchronisierten openlime.min.js-Vendor-Ordner (per `make sync_preview_rti_assets`)
// oder faellt ersatzweise auf den Build-Output des Viewer-Plugins im Nachbarverzeichnis zurueck.
function resolveVendorDir() {
	const candidates = [
		path.resolve(__dirname, 'rti-dist', 'vendor'),
		path.resolve(__dirname, '..', '..', '..', '..', 'fylr-plugin-ubhd-3d-viewer', 'src', 'webfrontend', 'rti-dist', 'vendor')
	]

	const vendorDir = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'openlime.min.js')))

	if (!vendorDir) {
		throw new Error(`Missing openlime.min.js. Looked in: ${candidates.join(', ')}`)
	}

	return vendorDir
}

// Baut die minimale HTML-Seite: laedt OpenLIME, haengt das RTI-Layer ein und schaltet nach dessen
// "ready"-Event in den Modus RTI_MODE um. Kein UIBasic/Skin noetig, da nur ein Screenshot benoetigt wird.
function buildHtml() {
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>UBHD RTI Preview</title>
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #ffffff; }
      .openlime { width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div class="openlime"></div>
    <script src="${VENDOR_VIRTUAL_BASE}openlime.min.js"></script>
    <script>
      window.__rtiReady = false;
      window.__rtiError = null;
      window.addEventListener('error', (event) => {
        window.__rtiError = String((event.error && event.error.message) || event.message || event);
      });
      try {
        const viewer = new OpenLIME.Viewer('.openlime');
        const layer = new OpenLIME.Layer({ type: 'rti', url: '${ASSET_VIRTUAL_BASE}info.json', layout: 'image' });
        viewer.addLayer('rti', layer);
        const onReady = () => {
          try {
            layer.setMode('${RTI_MODE}');
            window.__rtiReady = true;
          } catch (error) {
            window.__rtiError = String(error && error.message || error);
          }
        };
        if (layer.status === 'ready') onReady(); else layer.addEvent('ready', onReady);
      } catch (error) {
        window.__rtiError = String(error && error.message || error);
      }
    </script>
  </body>
</html>`
}

// Bedient alle Browser-Anfragen aus lokalen Dateien statt ueber einen echten Webserver.
// So bleibt das Preview-Rendering komplett im isolierten Rezeptlauf und ohne externe Abhaengigkeiten.
async function handleRequest(request, context) {
	const url = request.url()
	const method = request.method()

	if (!['GET', 'HEAD'].includes(method)) {
		await request.abort().catch(() => {})
		return
	}

	if (isRootPageRequest(url)) {
		await request.respond({
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
			body: method === 'HEAD' ? undefined : context.html
		})
		return
	}

	if (url.startsWith(VENDOR_VIRTUAL_BASE)) {
		const relativePath = decodeURIComponent(url.slice(VENDOR_VIRTUAL_BASE.length))
		const localPath = resolveWithinRoot(context.vendorDir, relativePath)
		if (localPath && fs.existsSync(localPath)) {
			await respondWithFile(request, localPath, inferMimeType(localPath))
			return
		}
	}

	if (url.startsWith(ASSET_VIRTUAL_BASE)) {
		const relativePath = decodeURIComponent(url.slice(ASSET_VIRTUAL_BASE.length))
		const localPath = resolveWithinRoot(context.extractDir, relativePath)
		if (localPath && fs.existsSync(localPath)) {
			await respondWithFile(request, localPath, inferMimeType(localPath))
			return
		}
	}

	await request.abort().catch(() => {})
}

// Erkennt, ob eine Anfrage auf die virtuelle Startseite der Preview-Session zeigt.
function isRootPageRequest(url) {
	try {
		const requestUrl = new URL(url)
		const rootUrl = new URL(ROOT_PAGE_URL)
		return requestUrl.origin === rootUrl.origin && (requestUrl.pathname === rootUrl.pathname || requestUrl.pathname === `${rootUrl.pathname}index.html`)
	} catch (_error) {
		return false
	}
}

// Liefert eine lokale Datei mit passendem Content-Type an die abgefangene Anfrage aus.
async function respondWithFile(request, filePath, contentType) {
	const stat = await fsp.stat(filePath)
	const body = request.method() === 'HEAD' ? undefined : await fsp.readFile(filePath)

	await request.respond({
		status: 200,
		headers: { 'Cache-Control': 'no-store', 'Content-Type': contentType, 'Content-Length': String(stat.size) },
		body
	})
}

// Loest eine angefragte relative Datei sicher innerhalb eines erlaubten Wurzelpfads auf.
function resolveWithinRoot(rootDir, relativePath) {
	const rootPath = path.resolve(rootDir)
	const candidatePath = path.resolve(rootPath, relativePath.replace(/^\/+/, ''))

	if (candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`)) {
		return candidatePath
	}

	return null
}

// Ordnet bekannten Dateiendungen die passenden MIME-Typen fuer die Browser-Antworten zu.
function inferMimeType(filePath) {
	switch (path.extname(filePath).toLowerCase()) {
		case '.js':
			return 'text/javascript; charset=utf-8'
		case '.json':
			return 'application/json; charset=utf-8'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.webp':
			return 'image/webp'
		default:
			return 'application/octet-stream'
	}
}

// Prueft frueh, ob eine benoetigte Eingabedatei vorhanden und lesbar ist.
function ensureReadableFile(filePath, label) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing ${label}: ${filePath}`)
	}

	fs.accessSync(filePath, fs.constants.R_OK)
}

// Sucht ein ausfuehrbares Chromium- oder Chrome-Binary in Variablen und Standardpfaden.
async function resolveBrowserExecutablePath() {
	for (const candidate of [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
		if (!candidate) {
			continue
		}

		try {
			await fsp.access(candidate, fs.constants.X_OK)
			return candidate
		} catch (_error) {
			continue
		}
	}

	return null
}

main().catch((error) => {
	console.error(`[rti2preview] ${error.message}`)

	if (error.stack) {
		console.error(error.stack)
	}

	process.exit(1)
})
