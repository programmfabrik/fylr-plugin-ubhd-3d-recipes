#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const puppeteer = require('puppeteer-core')
const { readExecutionInfo } = require('./readExecutionInfo')

const ROOT_PAGE_URL = 'https://ubhd-preview.local/'
const VIEWER_VIRTUAL_BASE = `${ROOT_PAGE_URL}viewer/`
const DRACO_VIRTUAL_BASE = `${ROOT_PAGE_URL}draco/`
const ASSET_VIRTUAL_BASE = `${ROOT_PAGE_URL}asset/`
const DEFAULT_VIEWPORT = { width: 512, height: 512 }

async function main() {
	const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

	if (!infoArg || !inputFile || !outputFile) {
		throw new Error('Usage: node model2preview.js <info-json-or-path> <source-url> <input-file> <output-file>')
	}

	const info = readExecutionInfo(infoArg)
	ensureReadableFile(inputFile, 'input model')

	const inputPath = path.resolve(inputFile)
	const outputPath = path.resolve(outputFile)
	const extension = path.extname(inputPath).toLowerCase()

	if (!['.glb', '.gltf'].includes(extension)) {
		throw new Error('model2preview only supports glb/gltf inputs. Use a GLB sourceversion for other formats.')
	}

	const viewerAssets = resolveViewerAssets()
	const executablePath = await resolveBrowserExecutablePath()

	if (!executablePath) {
		throw new Error('No Chromium executable found. Set PUPPETEER_EXECUTABLE_PATH or CHROME_BIN.')
	}

	const assetRootDir = path.dirname(inputPath)
	const assetUrl = `${ASSET_VIRTUAL_BASE}${encodeURIComponent(path.basename(inputPath))}`
	const html = buildHtml(viewerAssets)
	const pageUrl = new URL(ROOT_PAGE_URL)
	pageUrl.searchParams.set('asset', assetUrl)

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
		await page.setViewport({ ...DEFAULT_VIEWPORT, deviceScaleFactor: 1 })
		await page.setRequestInterception(true)

		const pageErrors = []

		page.on('pageerror', (error) => pageErrors.push(error))
		page.on('error', (error) => pageErrors.push(error))
		page.on('request', (request) => {
			void handleRequest(request, {
				assetRootDir,
				html,
				viewerAssets
			})
		})

		await page.goto(pageUrl.href, { waitUntil: 'domcontentloaded' })
		await page.waitForFunction(() => {
			const errorElement = document.getElementById('ubhd-3d-errors')
			if (errorElement && errorElement.textContent.trim()) {
				return true
			}

			const progressElement = document.getElementById('ubhd-3d-progress')
			if (progressElement && progressElement.getAttribute('aria-valuenow') === '100') {
				return true
			}

			return !!(window.ubhd3dviewer && window.ubhd3dviewer.renderer && window.ubhd3dviewer.renderer.instance)
		}, { timeout: Number(process.env.UBHD_PREVIEW_TIMEOUT_MS || 30000) })

		const viewerError = await page.evaluate(() => {
			const errorElement = document.getElementById('ubhd-3d-errors')
			return errorElement ? errorElement.textContent.trim() : ''
		})

		if (viewerError) {
			throw new Error(viewerError)
		}

		await page.waitForFunction(() => {
			const canvas = document.querySelector('canvas.webgl')
			if (!canvas) {
				return false
			}

			const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
			if (!gl) {
				return false
			}

			const pixels = new Uint8Array(4)
			gl.readPixels(
				Math.floor(canvas.width / 2),
				Math.floor(canvas.height / 2),
				1,
				1,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				pixels
			)

			return pixels.some((value) => value !== 0)
		}, { timeout: 5000 }).catch(() => null)

		await new Promise((resolve) => setTimeout(resolve, 300))
		await fsp.mkdir(path.dirname(outputPath), { recursive: true })
		await page.screenshot({ path: outputPath, type: 'jpeg', quality: 90, omitBackground: false })

		const outputStat = await fsp.stat(outputPath)
		if (!outputStat.size) {
			throw new Error(`Screenshot written but file is empty: ${outputPath}`)
		}

		if (pageErrors.length) {
			console.error('[model2preview] Browser page errors:', pageErrors)
		}

		console.error(`[model2preview] Rendered ${sourceUrl || info?._source?.url || inputFile} -> ${outputPath}`)
	} finally {
		if (page) {
			await page.close().catch(() => {})
		}

		await browser.close().catch(() => {})
	}
}

function resolveViewerAssets() {
	const viewerSearchRoots = [
		path.resolve(__dirname, 'viewer-dist'),
		path.resolve(__dirname, '..', '..', '..', '..', 'fylr-plugin-ubhd-3d-viewer', 'lib', 'ubhd-3d-viewer', 'dist')
	]

	const assetDirectory = viewerSearchRoots
		.map((rootDir) => path.join(rootDir, 'assets'))
		.find((candidate) => fs.existsSync(candidate))

	if (!assetDirectory) {
		throw new Error(`Missing viewer asset bundle. Looked in: ${viewerSearchRoots.join(', ')}`)
	}

	const bundlePath = ['index.js', 'ubhd-3d-viewer.js']
		.map((name) => path.join(assetDirectory, name))
		.find((candidate) => fs.existsSync(candidate))

	if (!bundlePath) {
		throw new Error(`Missing viewer bundle in ${assetDirectory}`)
	}

	const stylesheetPath = ['index.css', 'ubhd-3d-viewer.css']
		.map((name) => path.join(assetDirectory, name))
		.find((candidate) => fs.existsSync(candidate))

	const dracoDirectory = viewerSearchRoots
		.map((rootDir) => path.join(rootDir, 'draco'))
		.find((candidate) => fs.existsSync(candidate))

	return {
		bundlePath,
		bundleName: path.basename(bundlePath),
		dracoDirectory,
		stylesheetPath,
		stylesheetName: stylesheetPath ? path.basename(stylesheetPath) : null
	}
}

function buildHtml(viewerAssets) {
	const stylesheetMarkup = viewerAssets.stylesheetName
		? `<link rel="stylesheet" href="${VIEWER_VIRTUAL_BASE}${viewerAssets.stylesheetName}" />`
		: ''

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <base href="${ROOT_PAGE_URL}" />
    <title>UBHD Preview</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #ffffff;
      }

      #preview-root {
        width: 100%;
        height: 100%;
      }

      canvas.webgl {
        width: 100%;
        height: 100%;
        display: block;
      }
    </style>
    ${stylesheetMarkup}
  </head>
  <body>
    <div id="preview-root">
      <canvas class="webgl"></canvas>
    </div>
		<script type="module" src="${VIEWER_VIRTUAL_BASE}${viewerAssets.bundleName}"></script>
  </body>
</html>`
}

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

	if (url === `${ROOT_PAGE_URL}favicon.ico`) {
		await request.respond({ status: 204 })
		return
	}

	if (url === `${VIEWER_VIRTUAL_BASE}${context.viewerAssets.bundleName}`) {
		await respondWithFile(request, context.viewerAssets.bundlePath, 'text/javascript; charset=utf-8')
		return
	}

	if (context.viewerAssets.stylesheetName && url === `${VIEWER_VIRTUAL_BASE}${context.viewerAssets.stylesheetName}`) {
		await respondWithFile(request, context.viewerAssets.stylesheetPath, 'text/css; charset=utf-8')
		return
	}

	if (context.viewerAssets.dracoDirectory && url.startsWith(DRACO_VIRTUAL_BASE)) {
		const relativePath = decodeURIComponent(url.slice(DRACO_VIRTUAL_BASE.length))
		const localPath = resolveWithinRoot(context.viewerAssets.dracoDirectory, relativePath)
		if (localPath && fs.existsSync(localPath)) {
			await respondWithFile(request, localPath, inferMimeType(localPath))
			return
		}
	}

	if (url.startsWith(ASSET_VIRTUAL_BASE)) {
		const relativePath = decodeURIComponent(url.slice(ASSET_VIRTUAL_BASE.length))
		const localPath = resolveWithinRoot(context.assetRootDir, relativePath)
		if (localPath && fs.existsSync(localPath)) {
			await respondWithFile(request, localPath, inferMimeType(localPath))
			return
		}
	}

	await request.abort().catch(() => {})
}

function isRootPageRequest(url) {
	try {
		const requestUrl = new URL(url)
		const rootUrl = new URL(ROOT_PAGE_URL)
		return requestUrl.origin === rootUrl.origin && (requestUrl.pathname === rootUrl.pathname || requestUrl.pathname === `${rootUrl.pathname}index.html`)
	} catch (_error) {
		return false
	}
}

async function respondWithFile(request, filePath, contentType) {
	const body = request.method() === 'HEAD' ? undefined : await fsp.readFile(filePath)
	await request.respond({
		status: 200,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': contentType
		},
		body
	})
}

function resolveWithinRoot(rootDir, relativePath) {
	const rootPath = path.resolve(rootDir)
	const candidatePath = path.resolve(rootPath, relativePath.replace(/^\/+/, ''))

	if (candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`)) {
		return candidatePath
	}

	return null
}

function inferMimeType(filePath) {
	switch (path.extname(filePath).toLowerCase()) {
		case '.css':
			return 'text/css; charset=utf-8'
		case '.gltf':
			return 'model/gltf+json'
		case '.glb':
			return 'model/gltf-binary'
		case '.js':
			return 'text/javascript; charset=utf-8'
		case '.json':
			return 'application/json; charset=utf-8'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.wasm':
			return 'application/wasm'
		default:
			return 'application/octet-stream'
	}
}

function ensureReadableFile(filePath, label) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing ${label}: ${filePath}`)
	}

	fs.accessSync(filePath, fs.constants.R_OK)
}

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
	console.error(`[model2preview] ${error.message}`)

	if (error.stack) {
		console.error(error.stack)
	}

	process.exit(1)
})
