#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const obj2gltf = require('obj2gltf')
const { readExecutionInfo } = require('./readExecutionInfo')


/**
 * Einstiegspunkt.
 * Konvertiert eine OBJ Datei in eine GLB Datei. (binäres GLTF).
 * 
 * Liest folgende Argumente von der Kommandozeile:
 * 
 * @param {string} infoArg - Pfad zu einer JSON-Datei mit Metadaten (oder direkt JSON-String)
 * @param {string} sourceUrl - URL der Quelle (optional, wird nur für Logging verwendet)
 * @param {string} inputFile - Pfad zur Eingabe-OBJ-Datei
 * @param {string} outputFile - Pfad zur Ausgabedatei (GLB)    
 */
async function main() {
    const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

    if (!infoArg || !inputFile || !outputFile) {
        throw new Error('Usage: node obj2glb.js <info-json-or-path> <source-url> <input.obj> <output.glb>')
    }

    // Metadaten laden (aus Datei oder direktem JSON-String)
    const info = readExecutionInfo(infoArg)

    // Sicherstellen, dass die Eingabedatei existiert und lesbar ist
    ensureReadableFile(inputFile, 'input OBJ')

    // Zielverzeichnis anlegen, falls es noch nicht existiert
    const outputDirectory = path.dirname(outputFile)
    fs.mkdirSync(outputDirectory, { recursive: true })

    // Konvertierung durchführen: Z-up (OBJ-Konvention) -> Y-up (glTF-Konvention)
    const glb = await obj2gltf(inputFile, {
        binary: true,
        separate: false,
        secure: true,
        inputUpAxis: 'Z',
        outputUpAxis: 'Y'
    })
    // Ausgabedatei schreiben
    fs.writeFileSync(outputFile, glb)

    // Für Logging den Namen der Quelle bestimmen (entweder URL, Metadaten oder Eingabedatei)
    const sourceName = sourceUrl || info?._source?.url || inputFile
    console.error(`[obj2glb] Converted ${sourceName} -> ${outputFile}`)
}

/**
 * Prüft, ob eine benötigte Datei vorhanden und für den Prozess lesbar ist.
 * Dadurch werden Fehler beim späteren CLI-Aufruf früh und eindeutig abgefangen.
 * @param {string} filePath - Pfad zur Datei, die überprüft werden soll
 * @param {string} label - Bezeichnung der Datei für die Fehlermeldung
 */
function ensureReadableFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing ${label}: ${filePath}`)
    }

    fs.accessSync(filePath, fs.constants.R_OK)
}

// main() aufrufen und Fehler abfangen, um eine saubere Fehlermeldung auszugeben
main().catch((error) => {
    console.error(`[obj2glb] ${error.message}`)

    if (error.stack) {
        console.error(error.stack)
    }

    process.exit(1)
})
