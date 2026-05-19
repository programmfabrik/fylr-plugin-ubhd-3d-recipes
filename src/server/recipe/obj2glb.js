#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const obj2gltf = require('obj2gltf')
const { readExecutionInfo } = require('./readExecutionInfo')

// Konvertiert eine OBJ-Datei in ein einzelnes GLB fuer die weitere Viewer-Pipeline.
// Dabei werden Ausgabeordner, Achsorientierung und die abschliessende Protokollierung gesetzt.
async function main() {
	const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

	if (!infoArg || !inputFile || !outputFile) {
		throw new Error('Usage: node obj2glb.js <info-json-or-path> <source-url> <input.obj> <output.glb>')
	}

	const info = readExecutionInfo(infoArg)
	ensureReadableFile(inputFile, 'input OBJ')
	const outputDirectory = path.dirname(outputFile)

	fs.mkdirSync(outputDirectory, { recursive: true })

	const glb = await obj2gltf(inputFile, {
		binary: true,
		separate: false,
		secure: true,
		inputUpAxis: 'Z',
		outputUpAxis: 'Y'
	})

	fs.writeFileSync(outputFile, glb)

	const sourceName = sourceUrl || info?._source?.url || inputFile
	console.error(`[obj2glb] Converted ${sourceName} -> ${outputFile}`)
}

// Prueft frueh, ob die erwartete Eingabedatei vorhanden und lesbar ist.
// So bricht die Konvertierung mit einer klaren Meldung statt in der Bibliothek ab.
function ensureReadableFile(filePath, label) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing ${label}: ${filePath}`)
	}

	fs.accessSync(filePath, fs.constants.R_OK)
}

main().catch((error) => {
	console.error(`[obj2glb] ${error.message}`)

	if (error.stack) {
		console.error(error.stack)
	}

	process.exit(1)
})
