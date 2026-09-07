#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { readExecutionInfo } = require('./readExecutionInfo')


/**
 * Einstiegspunkt.
 * Konvertiert eine glTF Datei in eine GLB Datei. (binäres GLTF).
 * 
 * Liest folgende Argumente von der Kommandozeile:
 * 
 * @param {string} infoArg - Pfad zu einer JSON-Datei mit Metadaten (oder direkt JSON-String)
 * @param {string} sourceUrl - URL der Quelle (optional, wird nur für Logging verwendet)
 * @param {string} inputFile - Pfad zur Eingabe-glTF-Datei
 * @param {string} outputFile - Pfad zur Ausgabedatei (GLB)
 */
async function main() {
    const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

    if (!infoArg || !inputFile || !outputFile) {
        throw new Error('Usage: node gltf2glb.js <info-json-or-path> <source-url> <input.gltf> <output.glb>')
    }

    // Metadaten laden (aus Datei oder direktem JSON-String)
    const info = readExecutionInfo(infoArg)

    // Sicherstellen, dass die Eingabedatei existiert und lesbar ist
    ensureReadableFile(inputFile, 'input glTF')

    // Pfad zur gltf-transform CLI ermitteln
    const cliPath = path.resolve(__dirname, '..', '..', '..', 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js')
    
    // CLI-Aufruf vorbereiten (direkt oder via node)
    // invocation bedeutet, dass wir entweder direkt die CLI aufrufen 
    // oder node cli.js, je nachdem, was ausführbar ist.
    const invocation = await getCliInvocation(cliPath)

    // Zielverzeichnis anlegen, falls es noch nicht existiert
    await fsp.mkdir(path.dirname(outputFile), { recursive: true })

    // Konvertierung durchführen: glTF -> GLB
    await runCommand(invocation.command, [...invocation.prefixArgs, 'copy', path.resolve(inputFile), path.resolve(outputFile)])

    // Prüfen, ob die Ausgabedatei erfolgreich geschrieben wurde und nicht leer ist
    const outputStat = await fsp.stat(outputFile)
    if (!outputStat.size) {
        throw new Error(`GLB written but file is empty: ${outputFile}`)
    }

    // Für Logging den Namen der Quelle bestimmen (entweder URL, Metadaten oder Eingabedatei)
    const sourceName = sourceUrl || info?._source?.url || inputFile
    console.error(`[gltf2glb] Converted ${sourceName} -> ${outputFile}`)
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

/**
 * Ermittelt, wie die gltf-transform-CLI im aktuellen Deployment gestartet werden kann.
 * Direkte Ausfuehrung wird bevorzugt und faellt sonst auf `node cli.js` zurueck.
 * @param {string} cliPath - Pfad zur gltf-transform CLI
 * @returns {Promise<{command: string, prefixArgs: string[]}>} - Kommando und optionale Prefix-Argumente
 */
async function getCliInvocation(cliPath) {
    ensureReadableFile(cliPath, 'gltf-transform CLI')

    // Prüfen, ob die CLI direkt ausführbar ist
    // (z.B. auf Linux/MacOS mit Shebang und +x)
    // Falls nicht, wird node cli.js verwendet.
    try {
        fs.accessSync(cliPath, fs.constants.X_OK)
        return { command: cliPath, prefixArgs: [] }
    } catch (_error) {
        return { command: process.execPath, prefixArgs: [cliPath] }
    }
}

/**
 * Führt einen externen Konvertierungsprozess aus und reicht dessen Logs direkt durch.
 * Ein Exit-Code ungleich null wird sofort als Rezeptfehler an den Aufrufer gemeldet.
 * @param {string} command - Kommando, das ausgeführt werden soll (z.B. Pfad zur CLI)
 * @param {string[]} args - Argumente für das Kommando
 * @returns {Promise<void>} - Promise, die aufgelöst wird, wenn der Prozess erfolgreich beendet wurde
 * @throws {Error} - Wenn der Prozess mit einem Fehlercode beendet wird
 */
function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        // spawn() startet einen neuen, externen Prozess (z.B. gltf-transform) als Subprozess.
        // Anders als exec() liefert spawn() die Ausgabe als Stream statt als fertigen String;
        // das macht es speicherschonender für große Ausgaben, aber wir müssen selbst zuhören.
        const child = spawn(command, args, { 
            cwd: __dirname, // Arbeitsverzeichnis auf das aktuelle Skript setzen
            stdio: ['ignore', 'pipe', 'pipe'] // Standardausgabe und Standardfehler werden durchgereicht
            // stdio legt fest, wie die drei Standard-Kanäle des Kindprozesses gehandhabt werden:
            // 1. stdin  = 'ignore' -> Kindprozess bekommt keine Eingabe von uns
            // 2. stdout = 'pipe'   -> Standardausgabe wird als Stream an uns durchgereicht (child.stdout)
            // 3. stderr = 'pipe'   -> Standardfehlerausgabe ebenso (child.stderr)
        })

        // child ist ein ChildProcess-Objekt, d.h. eine "Fernbedienung" für den laufenden Subprozess.
        // Es ist ein EventEmitter — wir registrieren uns für Ereignisse, statt auf einen
        // Rückgabewert zu warten, weil der Prozess im Hintergrund läuft und wir nicht wissen,
        // wann (oder wie oft) Daten ankommen.

        // Jedes Mal, wenn der ChildProcess etwas auf stdout schreibt, kommt hier ein "data"-Event
        // mit einem Chunk (Buffer) an. Wir reichen ihn 1:1 an unsere eigene Standardausgabe weiter,
        // damit der Aufrufer live sieht, was der Subprozess ausgibt.
        child.stdout.on('data', (chunk) => process.stdout.write(chunk))
        child.stderr.on('data', (chunk) => process.stderr.write(chunk))

        // 'error' feuert, wenn der Prozess gar nicht erst gestartet werden konnte
        // (z.B. Programm nicht gefunden). Das ist etwas anderes als ein Fehler-Exitcode.
        child.on('error', reject)

        // 'close' feuert, wenn der Prozess beendet ist UND alle stdio-Streams geschlossen sind.
        // code ist der Exit-Code des Prozesses: 0 bedeutet üblicherweise "erfolgreich".
        child.on('close', (code) => {
            if (code === 0) {
                resolve()
                return
            }
            // Fehlerbehandlung: Prozess ist mit einem Fehlercode beendet worden
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