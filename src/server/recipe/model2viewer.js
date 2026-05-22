#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { readExecutionInfo } = require('./readExecutionInfo')

// Steuert die komplette Umwandlung eines Uploads in ein viewer-taugliches GLB.
// Je nach Eingabeformat werden die passenden Teilschritte aufgerufen und das Ergebnis validiert.
async function main() {
	const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

	if (!infoArg || !inputFile || !outputFile) {
		throw new Error('Usage: node model2viewer.js <info-json-or-path> <source-url> <input-model> <output-file>')
	}

	const info = readExecutionInfo(infoArg)
	ensureReadableFile(inputFile, 'input model')

	const inputPath = path.resolve(inputFile)
	const outputPath = path.resolve(outputFile)
	const extension = path.extname(inputPath).toLowerCase()
	const normalizedSourceUrl = sourceUrl || ''

	await fsp.mkdir(path.dirname(outputPath), { recursive: true })

	if (isNexusExtension(extension)) {
		await fsp.copyFile(inputPath, outputPath)
		await assertNonEmptyFile(outputPath, 'viewer model')
		console.error(`[model2viewer] Forwarded Nexus viewer model ${normalizedSourceUrl || info?._source?.url || inputPath} -> ${outputPath}`)
		return
	}

	if (extension === '.glb') {
		await runRecipeScript('glb2draco.js', [infoArg, normalizedSourceUrl, inputPath, outputPath])
		await assertNonEmptyFile(outputPath, 'viewer model')
		console.error(`[model2viewer] Prepared viewer model ${normalizedSourceUrl || info?._source?.url || inputPath} -> ${outputPath}`)
		return
	}

	if (extension !== '.gltf' && extension !== '.obj') {
		throw new Error(`Unsupported input extension for model2viewer: ${extension || '<none>'}`)
	}

	const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ubhd-model2viewer-'))
	const intermediateGlb = path.join(tempRoot, 'model.glb')

	try {
		const converterScript = extension === '.obj' ? 'obj2glb.js' : 'gltf2glb.js'
		await runRecipeScript(converterScript, [infoArg, normalizedSourceUrl, inputPath, intermediateGlb])
		await runRecipeScript('glb2draco.js', [infoArg, normalizedSourceUrl, intermediateGlb, outputPath])
		await assertNonEmptyFile(outputPath, 'viewer model')
		console.error(`[model2viewer] Prepared viewer model ${normalizedSourceUrl || info?._source?.url || inputPath} -> ${outputPath}`)
	} finally {
		await fsp.rm(tempRoot, { recursive: true, force: true })
	}
}

function isNexusExtension(extension) {
	return extension === '.nxs' || extension === '.nxz'
}

// Prueft frueh, ob eine benoetigte Datei existiert und fuer den Prozess lesbar ist.
// So werden Folgefehler spaeter in der Pipeline auf einen klaren Einstiegspunkt reduziert.
function ensureReadableFile(filePath, label) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing ${label}: ${filePath}`)
	}

	fs.accessSync(filePath, fs.constants.R_OK)
}

// Stellt sicher, dass ein erzeugtes Artefakt nicht nur existiert, sondern auch Inhalt hat.
// Leere Ausgabedateien werden damit sofort als Fehler der Konvertierung erkannt.
async function assertNonEmptyFile(filePath, label) {
	const stat = await fsp.stat(filePath)

	if (!stat.size) {
		throw new Error(`${label} written but file is empty: ${filePath}`)
	}
}

// Startet ein Nachbarskript der Rezeptkette als eigenen Node-Prozess.
// Standardausgabe und Fehlerausgabe werden durchgereicht, damit FAS die Logs komplett sieht.
function runRecipeScript(scriptName, args) {
	return new Promise((resolve, reject) => {
		const scriptPath = path.resolve(__dirname, scriptName)
		const child = spawn(process.execPath, [scriptPath, ...args], {
			cwd: __dirname,
			stdio: ['ignore', 'pipe', 'pipe']
		})

		child.stdout.on('data', (chunk) => process.stdout.write(chunk))
		child.stderr.on('data', (chunk) => process.stderr.write(chunk))
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) {
				resolve()
				return
			}

			reject(new Error(`${scriptName} exited with code ${code}`))
		})
	})
}

main().catch((error) => {
	console.error(`[model2viewer] ${error.message}`)

	if (error.stack) {
		console.error(error.stack)
	}

	process.exit(1)
})