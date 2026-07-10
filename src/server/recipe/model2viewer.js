#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { readExecutionInfo } = require('./readExecutionInfo')

// Steuert die komplette Umwandlung eines Uploads in ein viewer-taugliches GLB.
// Je nach Eingabeformat werden die passenden Teilschritte aufgerufen und das Ergebnis validiert.

/**
 * Einstiegspunkt.
 * Konvertiert ein beliebiges 3D-Modell in ein GLB für den Viewer.
 * 
 * Liest folgende Argumente von der Kommandozeile:
 * 
 * @param {string} infoArg - Pfad zu einer JSON-Datei mit Metadaten (oder direkt JSON-String)
 * @param {string} sourceUrl - URL der Quelle (optional, wird nur für Logging verwendet)
 * @param {string} inputFile - Pfad zur Eingabe-3D-Datei
 * @param {string} outputFile - Pfad zur Ausgabedatei (GLB)
 */
async function main() {
    const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

    if (!infoArg || !inputFile || !outputFile) {
        throw new Error('Usage: node model2viewer.js <info-json-or-path> <source-url> <input-model> <output-file>')
    }

    // Metadaten laden (aus Datei oder direktem JSON-String)
    const info = readExecutionInfo(infoArg)

    // Sicherstellen, dass die Eingabedatei existiert und lesbar ist
    ensureReadableFile(inputFile, 'input model')

    // Absolute Pfade verwenden: die aufgerufenen Sub-Skripte (siehe runRecipeScript
    // weiter unten) laufen evtl. mit einem anderen Arbeitsverzeichnis, deshalb
    // müssen die Pfade unabhängig davon eindeutig sein.
    const inputPath = path.resolve(inputFile)
    const outputPath = path.resolve(outputFile)

    // Dateiendung (kleingeschrieben) bestimmt, welcher Konvertierungsweg
    // weiter unten eingeschlagen wird
    const extension = path.extname(inputPath).toLowerCase()

    // sourceUrl ist optional -> leerer String als sicherer Standardwert,
    // damit wir nicht überall separat auf undefined prüfen müssen
    const normalizedSourceUrl = sourceUrl || ''

    // Zielverzeichnis anlegen, falls es noch nicht existiert
    await fsp.mkdir(path.dirname(outputPath), { recursive: true })

    // Fall 1: Nexus-Format (.nxs/.nxz) — ein Format für sehr große,
    // hochaufgelöste 3D-Scans, das der Viewer in mehreren Detailstufen
    // nachladen kann (Multiresolution-Streaming), ähnlich wie Kartendienste
    // beim Hinein-/Herauszoomen nachladen. Solche Dateien liegen bereits
    // fertig für den Viewer vor -> keine Konvertierung nötig, nur kopieren.
    if (isNexusExtension(extension)) {
        await fsp.copyFile(inputPath, outputPath)
        await assertNonEmptyFile(outputPath, 'viewer model')
        console.error(`[model2viewer] Forwarded Nexus viewer model ${normalizedSourceUrl || info?._source?.url || inputPath} -> ${outputPath}`)
        return
    }

    // Fall 2: Eingabe ist bereits GLB -> keine Formatumwandlung nötig,
    // nur noch auf Draco-Kompression prüfen (glb2draco.js ist das Skript,
    // das wir in einem vorherigen Beispiel besprochen haben).
    // runRecipeScript startet dieses Skript vermutlich als eigenen Prozess
    // (ähnlich wie spawn() aus einem früheren Beispiel).
    if (extension === '.glb') {
        await runRecipeScript('glb2draco.js', [infoArg, normalizedSourceUrl, inputPath, outputPath])
        await assertNonEmptyFile(outputPath, 'viewer model')
        console.error(`[model2viewer] Prepared viewer model ${normalizedSourceUrl || info?._source?.url || inputPath} -> ${outputPath}`)
        return
    }

    // Fall 3: Alles außer .gltf und .obj wird nicht unterstützt -> Abbruch.
    // Diese Prüfung kommt erst jetzt, weil .glb und Nexus oben bereits
    // per "return" behandelt und aus der Funktion herausgeführt wurden.
    if (extension !== '.gltf' && extension !== '.obj') {
        throw new Error(`Unsupported input extension for model2viewer: ${extension || '<none>'}`)
    }

    // Fall 4: .gltf oder .obj -> zweistufige Konvertierung nötig, weil beide
    // Formate erst zu GLB gewandelt werden müssen, bevor die Draco-Prüfung
    // (wie in Fall 2) angewendet werden kann:
    //   Eingabe (.obj/.gltf) --Schritt 1--> temporäres GLB --Schritt 2--> Ausgabe
    //
    // Für das Zwischenergebnis legen wir ein temporäres Verzeichnis an,
    // damit die Zwischendatei nicht im Zielordner landet oder mit parallel
    // laufenden Konvertierungen kollidiert. os.tmpdir() liefert dafür den
    // vom Betriebssystem vorgesehenen Temp-Ordner (z.B. /tmp unter Linux).
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ubhd-model2viewer-'))
    const intermediateGlb = path.join(tempRoot, 'model.glb')

    try {
        // Je nach Ausgangsformat das passende Konvertierungsskript wählen:
        // .obj  -> obj2glb.js   (siehe eines der vorherigen Beispiele)
        // .gltf -> gltf2glb.js  (analoges Skript, nur für GLTF statt OBJ)
        const converterScript = extension === '.obj' ? 'obj2glb.js' : 'gltf2glb.js'
        
        // Schritt 1: Eingabedatei -> temporäre GLB-Zwischendatei
        await runRecipeScript(converterScript, [infoArg, normalizedSourceUrl, inputPath, intermediateGlb])
        
        // Schritt 2: temporäre GLB-Datei -> finale Ausgabedatei,
        // inklusive Draco-Kompressionsprüfung (identischer Ablauf wie in Fall 2)
        await runRecipeScript('glb2draco.js', [infoArg, normalizedSourceUrl, intermediateGlb, outputPath])
        
        await assertNonEmptyFile(outputPath, 'viewer model')
        console.error(`[model2viewer] Prepared viewer model ${normalizedSourceUrl || info?._source?.url || inputPath} -> ${outputPath}`)
    } finally {
        // Temporäres Verzeichnis samt Zwischendatei in jedem Fall aufräumen,
        // egal ob die Konvertierung erfolgreich war oder ein Fehler auftrat
        await fsp.rm(tempRoot, { recursive: true, force: true })
    }
}

/**
 * Prüft anhand der Dateiendung, ob es sich um ein Nexus-Modell handelt.
 * Nexus-Modelle sind bereits für den Viewer optimiert und müssen nicht konvertiert werden.
 * 
 * @param {string} extension - Dateiendung (inkl. Punkt, z.B. ".nxs" oder ".nxz")
 * @returns {boolean} - true, wenn es sich um ein Nexus-Modell handelt, sonst false
 */
function isNexusExtension(extension) {
    return extension === '.nxs' || extension === '.nxz'
}

/**
 * Prüft, ob eine benötigte Datei vorhanden und für den Prozess lesbar ist.
 * Dadurch werden Fehler beim späteren CLI-Aufruf früh und eindeutig abgefangen.
 * 
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
 * Prüft, ob eine erzeugte Datei nicht leer ist.
 * Dadurch werden Fehler beim späteren CLI-Aufruf früh und eindeutig abgefangen.
 * 
 * @param {string} filePath - Pfad zur Datei, die überprüft werden soll
 * @param {string} label - Bezeichnung der Datei für die Fehlermeldung
 */
async function assertNonEmptyFile(filePath, label) {
    const stat = await fsp.stat(filePath)

    if (!stat.size) {
        throw new Error(`${label} written but file is empty: ${filePath}`)
    }
}

/**
 * Startet ein Nachbarskript der Rezeptkette als eigenen Node-Prozess.
 * Standardausgabe und Fehlerausgabe werden durchgereicht, damit FAS die Logs komplett sieht.
 * 
 * @param {string} scriptName - Name des Skripts (z.B. "obj2glb.js")
 * @param {string[]} args - Argumente, die an das Skript übergeben werden sollen
 * @returns {Promise<void>} - Promise, die aufgelöst wird, wenn das Skript erfolgreich beendet wurde
 * @throws {Error} - Wenn das Skript mit einem Fehlercode beendet wird
 */
function runRecipeScript(scriptName, args) {
    return new Promise((resolve, reject) => {
        // scriptName ist nur ein Dateiname (z.B. 'glb2draco.js'), kein Pfad.
        // path.resolve(__dirname, scriptName) geht davon aus, dass das Zielskript
        // im selben Verzeichnis liegt wie diese Datei hier -> daher "Nachbarskript".
        const scriptPath = path.resolve(__dirname, scriptName)

        // Anders als runCommand() bekommt spawn() hier nicht irgendein beliebiges
        // Kommando von außen, sondern IMMER process.execPath — das ist der absolute
        // Pfad zur Node.js-Programmdatei, mit der der aktuelle Prozess selbst läuft.
        // Das ist gleichbedeutend mit einem Terminal-Aufruf wie:
        //   node <scriptPath> <arg1> <arg2> ...
        // scriptPath landet dabei als erstes Element im Argument-Array, gefolgt von
        // den eigentlichen Argumenten (...args) — genau die Werte, die im
        // Kindprozess später über dessen eigenes process.argv ausgelesen werden
        // (siehe main() in obj2glb.js / glb2draco.js).
        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd: __dirname,
            stdio: ['ignore', 'pipe', 'pipe']
            // stdio legt fest, wie die drei Standard-Kanäle des Kindprozesses gehandhabt werden:
            // 1. stdin  = 'ignore' -> Kindprozess bekommt keine Eingabe von uns
            // 2. stdout = 'pipe'   -> Standardausgabe wird als Stream an uns durchgereicht (child.stdout)
            // 3. stderr = 'pipe'   -> Standardfehlerausgabe ebenso (child.stderr)
        })

        // child ist wieder ein ChildProcess-Objekt (EventEmitter) — unsere
        // "Fernbedienung" für den laufenden Sub-Prozess, siehe runCommand()
        // für die ausführlichere Erklärung dieses Konzepts.

        // Jeder Ausgabe-Chunk des Kindprozesses wird 1:1 an unsere eigene
        // Standardausgabe weitergereicht, damit der Aufrufer live mitliest.
        child.stdout.on('data', (chunk) => process.stdout.write(chunk))
        child.stderr.on('data', (chunk) => process.stderr.write(chunk))

        // 'error': der Kindprozess konnte gar nicht erst gestartet werden
        // (z.B. weil scriptPath nicht existiert)
        child.on('error', reject)

        // 'close': Kindprozess ist beendet UND alle stdio-Streams sind geschlossen.
        // code === 0 bedeutet Erfolg, alles andere ein Fehler im Nachbarskript.
        child.on('close', (code) => {
            if (code === 0) {
                resolve()
                return
            }
            // Im Unterschied zu runCommand() ist die Fehlermeldung hier dynamisch:
            // scriptName benennt das tatsächlich gescheiterte Skript, statt einen
            // fest einprogrammierten Namen zu verwenden.
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