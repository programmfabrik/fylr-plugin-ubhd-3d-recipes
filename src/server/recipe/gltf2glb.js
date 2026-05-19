#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { readExecutionInfo } = require('./readExecutionInfo')

// Wandelt ein glTF-Modell ueber gltf-transform in ein GLB fuer die Folgeschritte um.
// Die Funktion kuemmert sich um CLI-Aufruf, Zielverzeichnis und Ergebnispruefung.
async function main() {
	const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

	if (!infoArg || !inputFile || !outputFile) {
		throw new Error('Usage: node gltf2glb.js <info-json-or-path> <source-url> <input.gltf> <output.glb>')
	}

	const info = readExecutionInfo(infoArg)
	ensureReadableFile(inputFile, 'input glTF')

	const cliPath = path.resolve(__dirname, '..', '..', '..', 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js')
	const invocation = await getCliInvocation(cliPath)

	await fsp.mkdir(path.dirname(outputFile), { recursive: true })
	await runCommand(invocation.command, [...invocation.prefixArgs, 'copy', path.resolve(inputFile), path.resolve(outputFile)])

	const outputStat = await fsp.stat(outputFile)
	if (!outputStat.size) {
		throw new Error(`GLB written but file is empty: ${outputFile}`)
	}

	const sourceName = sourceUrl || info?._source?.url || inputFile
	console.error(`[gltf2glb] Converted ${sourceName} -> ${outputFile}`)
}

// Prueft, ob eine benoetigte Datei vorhanden und fuer den Prozess lesbar ist.
// Dadurch werden Fehler beim spaeteren CLI-Aufruf frueh und eindeutig abgefangen.
function ensureReadableFile(filePath, label) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing ${label}: ${filePath}`)
	}

	fs.accessSync(filePath, fs.constants.R_OK)
}

// Ermittelt, wie die gltf-transform-CLI im aktuellen Deployment gestartet werden kann.
// Direkte Ausfuehrung wird bevorzugt und faellt sonst auf `node cli.js` zurueck.
async function getCliInvocation(cliPath) {
	ensureReadableFile(cliPath, 'gltf-transform CLI')

	try {
		fs.accessSync(cliPath, fs.constants.X_OK)
		return { command: cliPath, prefixArgs: [] }
	} catch (_error) {
		return { command: process.execPath, prefixArgs: [cliPath] }
	}
}

// Fuehrt einen externen Konvertierungsprozess aus und reicht dessen Logs direkt durch.
// Ein Exit-Code ungleich null wird sofort als Rezeptfehler an den Aufrufer gemeldet.
function runCommand(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
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

			reject(new Error(`gltf-transform exited with code ${code}`))
		})
	})
}

main().catch((error) => {
	console.error(`[gltf2glb] ${error.message}`)

	if (error.stack) {
		console.error(error.stack)
	}

	process.exit(1)
})