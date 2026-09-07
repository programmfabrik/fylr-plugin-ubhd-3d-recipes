#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { readExecutionInfo } = require('./readExecutionInfo')

const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a
const DRACO_EXTENSION_NAME = 'KHR_draco_mesh_compression'


/**
 * Einstiegspunkt.
 * Konvertiert eine GLB Datei in eine GLB Datei mit Draco-Kompression.
 * 
 * Liest folgende Argumente von der Kommandozeile:
 * 
 * @param {string} infoArg - Pfad zu einer JSON-Datei mit Metadaten (oder direkt JSON-String)
 * @param {string} sourceUrl - URL der Quelle (optional, wird nur für Logging verwendet)
 * @param {string} inputFile - Pfad zur Eingabe-GLB-Datei
 * @param {string} outputFile - Pfad zur Ausgabedatei (GLB)
 */
async function main() {
    const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

    if (!infoArg || !inputFile || !outputFile) {
        throw new Error('Usage: node glb2draco.js <info-json-or-path> <source-url> <input.glb> <output.glb>')
    }

    // Metadaten laden (aus Datei oder direktem JSON-String)
    const info = readExecutionInfo(infoArg)

    // Sicherstellen, dass die Eingabedatei existiert und lesbar ist
    ensureReadableFile(inputFile, 'input GLB')

    // Pfad zur gltf-transform CLI ermitteln
    const cliPath = path.resolve(__dirname, '..', '..', '..', 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js')
    
    // CLI-Aufruf vorbereiten (direkt oder via node)
    // invocation bedeutet, dass wir entweder direkt die CLI aufrufen 
    // oder node cli.js, je nachdem, was ausführbar ist.
    const invocation = await getCliInvocation(cliPath)

    // Minimalen Größenvorteil für akzeptierte Draco-Ergebnisse ermitteln.
    // z.B. 0.1 würde bedeuten: Kompression wird nur akzeptiert, wenn sie
    // mindestens 10% kleiner ist als das Original.
    const minimumSavingsRatio = getMinimumSavingsRatio()

    // Zielverzeichnis anlegen, falls es noch nicht existiert
    await fsp.mkdir(path.dirname(outputFile), { recursive: true })

    // Eingabedatei einlesen: Dateigröße (für den späteren Vergleich)
    const inputStat = await fsp.stat(inputFile)

    // Für Logging den Namen der Quelle bestimmen:
    // bevorzugt die übergebene URL, sonst aus den Metadaten, sonst der Dateipfad als Fallback
    const sourceName = sourceUrl || info?._source?.url || inputFile

    // Kompression versuchen (ob bereits Draco-komprimiert wird durch extractMetadata.js geprüft)

    // Temporäres Verzeichnis anlegen, damit wir die komprimierte Version erst
    // testen können, bevor wir irgendetwas an der finalen Ausgabedatei ändern.
    // mkdtemp fügt automatisch ein zufälliges Suffix an den Präfix an,
    // damit parallele Läufe sich nicht in die Quere kommen.
    const tempDir = await fsp.mkdtemp(path.join(path.dirname(outputFile), 'glb2draco-'))
    const tempOutputFile = path.join(tempDir, 'model.draco.glb')

    try {
        // gltf-transform CLI mit Draco-Kompressionsargumenten aufrufen
        // (Ergebnis landet zunächst nur im temporären Verzeichnis)
        const args = buildDracoArgs(path.resolve(inputFile), path.resolve(tempOutputFile))
        await runCommand(invocation.command, [...invocation.prefixArgs, ...args])

        // Größe des komprimierten Ergebnisses ermitteln und mit dem Original vergleichen
        const compressedStat = await fsp.stat(tempOutputFile)
        const savingsRatio = inputStat.size > 0 ? (inputStat.size - compressedStat.size) / inputStat.size : 0

        // Kompression nur übernehmen, wenn sie tatsächlich kleiner ist
        // UND der Größenvorteil die Mindestschwelle erreicht.
        // (Bei sehr kleinen oder schon optimierten Dateien kann Draco die Größe
        // sogar erhöhen, deshalb die zusätzliche Prüfung.)
        if (compressedStat.size < inputStat.size && savingsRatio >= minimumSavingsRatio) {
            await fsp.copyFile(tempOutputFile, outputFile)
            console.error(`[glb2draco] Accepted compressed output for ${sourceName}`)
        } else {
            // Kompression hat sich nicht gelohnt -> Original unverändert übernehmen
            await fsp.copyFile(inputFile, outputFile)
            console.error(`[glb2draco] Skipped compression for ${sourceName}, savings were not beneficial`)
        }
    } finally {
        // Temporäres Verzeichnis in jedem Fall aufräumen, egal ob die Kompression
        // erfolgreich war oder ein Fehler geworfen wurde
        await fsp.rm(tempDir, { recursive: true, force: true })
    }

    // Abschließende Prüfung: fertige Ausgabedatei darf nicht leer sein
    // (würde auf einen stillen Fehler weiter oben hindeuten)
    const outputStat = await fsp.stat(outputFile)
    if (!outputStat.size) {
        throw new Error(`GLB written but file is empty: ${outputFile}`)
    }

    console.error(`[glb2draco] ${inputStat.size} -> ${outputStat.size} bytes`)
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
 * Ermittelt, wie die gltf-transform-CLI im aktuellen Deployment gestartet werden kann.
 * Direkte Ausfuehrung wird bevorzugt und faellt sonst auf `node cli.js` zurueck.
 * 
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

// Baut die Argumentliste fuer den Draco-CLI-Aufruf aus Pflichtwerten und optionalen Overrides.
// Umgebungsvariablen koennen damit das Kompressionsverhalten ohne Codeaenderung anpassen.
function buildDracoArgs(inputFile, outputFile) {
    const args = ['draco', inputFile, outputFile, '--method', 'edgebreaker']
    appendOption(args, '--encode-speed', process.env.UBHD_GLB2DRACO_ENCODE_SPEED)
    appendOption(args, '--decode-speed', process.env.UBHD_GLB2DRACO_DECODE_SPEED)
    appendOption(args, '--quantize-position', process.env.UBHD_GLB2DRACO_QUANTIZE_POSITION)
    appendOption(args, '--quantize-normal', process.env.UBHD_GLB2DRACO_QUANTIZE_NORMAL)
    appendOption(args, '--quantize-texcoord', process.env.UBHD_GLB2DRACO_QUANTIZE_TEXCOORD)
    appendOption(args, '--quantize-color', process.env.UBHD_GLB2DRACO_QUANTIZE_COLOR)
    appendOption(args, '--quantize-generic', process.env.UBHD_GLB2DRACO_QUANTIZE_GENERIC)
    appendOption(args, '--quantization-volume', process.env.UBHD_GLB2DRACO_QUANTIZATION_VOLUME)
    return args
}

/**
 * Fügt ein optionales CLI-Flag nur dann an, wenn dafür ein sinnvoller Wert vorliegt.
 * 
 * @param {string[]} args - Array der Argumente, das erweitert wird
 * @param {string} flag - Das CLI-Flag, das hinzugefügt werden soll
 * @param {string|number|undefined|null} value - Der Wert für das Flag
 */
function appendOption(args, flag, value) {
    if (value === undefined || value === null || value === '') {
        return
    }

    args.push(flag, String(value))
}

/**
 * Ermittelt den minimalen Größenvorteil, der für akzeptierte Draco-Kompressionen erforderlich ist.
 * 
 * @returns {number} - Minimaler Größenvorteil als Zahl zwischen 0 und 1 (z.B. 0.1 für 10%)
 */
function getMinimumSavingsRatio() {
    const value = Number(process.env.UBHD_GLB2DRACO_MIN_SAVINGS_RATIO ?? 0)

    if (!Number.isFinite(value)) {
        return 0
    }

    return Math.min(Math.max(value, 0), 1)
}

/**
 * Liest den JSON-Chunk einer GLB-Datei ein, um Metadaten zu extrahieren.
 * 
 * Hintergrund zu Binärparsing: GLB-Dateien bestehen aus einem Header und mehreren Chunks. 
 * Der erste Chunk ist immer JSON, der zweite ist binär (z.B. Mesh-Daten). 
 * Wir müssen nur den JSON-Chunk lesen, um zu prüfen, ob Draco-Kompression verwendet wird.
 * 
 * @param {string} filePath - Pfad zur GLB-Datei
 * @returns {Promise<Object>} - Promise, die das geparste JSON-Objekt zurückgibt
 * @throws {Error} - Wenn die Datei kein gültiges GLB ist oder der JSON-Chunk fehlt
 */
async function readGlbJson(filePath) {
    // Datei öffnen, ohne sie komplett in den Speicher zu laden.
    // fileHandle erlaubt uns, gezielt an bestimmten Byte-Positionen zu lesen,
    // statt die ganze (potenziell große) Datei einzulesen.
    const fileHandle = await fsp.open(filePath, 'r')

    try {
        // Das GLB-Format hat einen 12-Byte-Header, gefolgt vom Beginn des ersten
        // Chunk-Headers (8 Byte). Wir lesen hier 20 Byte auf einmal, um beides
        // in einem Rutsch zu bekommen.
        const header = Buffer.alloc(20)
        const headerRead = await fileHandle.read(header, 0, header.length, 0)
        // Ein Buffer ist Node.js' Art, rohe Binärdaten (Bytes) zu repräsentieren.
        // Im Gegensatz zu Strings, die für Text gedacht sind. Buffer.alloc(20) 
        // reserviert einen 20 Byte großen, leeren Speicherbereich, den wir dann 
        // mit echten Daten befüllen lassen.

        // Prüfen, ob überhaupt genug Bytes gelesen wurden (Datei könnte kürzer
        // sein als erwartet, z.B. abgeschnitten oder gar kein echtes GLB)
        if (headerRead.bytesRead < header.length) {
            throw new Error(`GLB header too short: ${filePath}`)
        }

        // Die ersten 4 Byte sind die "Magic Number" — eine feste Byte-Folge,
        // die jede gültige GLB-Datei am Anfang haben muss (quasi ihr Erkennungszeichen).
        // readUInt32LE liest 4 Byte als 32-Bit-Ganzzahl im "Little-Endian"-Format
        // (die Byte-Reihenfolge, die GLB laut Spezifikation vorschreibt).
        if (header.readUInt32LE(0) !== GLB_MAGIC) {
            throw new Error(`Invalid GLB magic for ${filePath}`)
        }

        // Byte 4-7: Versionsnummer des GLB-Formats. Wir unterstützen nur Version 2
        // (die aktuelle glTF-Binärversion).
        if (header.readUInt32LE(4) !== 2) {
            throw new Error(`Unsupported GLB version for ${filePath}`)
        }

        // Ab Byte 12 beginnt der erste Chunk-Header:
        // Byte 12-15: Länge des Chunk-Inhalts in Byte
        const jsonChunkLength = header.readUInt32LE(12)

        // Byte 16-19: Typ des Chunks. Der allererste Chunk in einer gültigen
        // GLB-Datei muss laut Spezifikation immer der JSON-Chunk sein.
        // GLB_JSON_CHUNK_TYPE ist vermutlich eine Konstante für genau diesen Typ-Code.
        if (header.readUInt32LE(16) !== GLB_JSON_CHUNK_TYPE) {
            throw new Error(`Missing JSON chunk in ${filePath}`)
        }

        // Jetzt, wo wir wissen wie lang der JSON-Chunk ist, lesen wir genau
        // diesen Bereich der Datei — ab Byte-Position 20 (direkt nach dem Header)
        const jsonChunk = Buffer.alloc(jsonChunkLength)
        const jsonRead = await fileHandle.read(jsonChunk, 0, jsonChunkLength, 20)

        if (jsonRead.bytesRead < jsonChunkLength) {
            throw new Error(`Incomplete GLB JSON chunk in ${filePath}`)
        }

        // Chunk-Inhalt in Text umwandeln und parsen.
        // GLB-JSON-Chunks werden laut Spezifikation mit Null-Bytes (\u0000) aufgefüllt,
        // damit die Chunk-Länge durch 4 teilbar ist — die müssen vor dem Parsen
        // entfernt werden, sonst schlägt JSON.parse fehl.
        return JSON.parse(jsonChunk.toString('utf8').replace(/\u0000+$/, ''))
    } finally {
        // Datei-Handle in jedem Fall schließen, egal ob erfolgreich oder Fehler,
        // damit keine offenen Dateizugriffe zurückbleiben.
        await fileHandle.close()
    }
}

/**
 * Prüft, ob ein GLB-JSON bereits Draco-Kompression verwendet.
 * @param {Object} json - Das geparste JSON-Objekt aus dem GLB
 * @returns {boolean} - true, wenn Draco-Kompression verwendet wird, sonst false
 */
function hasDracoCompression(json) {
    // Absicherung: falls json fehlt oder kein Objekt ist (z.B. null, undefined,
    // oder ein kaputtes Parsing-Ergebnis), gilt das als "keine Kompression"
    // statt einen Fehler zu werfen.
    if (!json || typeof json !== 'object') {
        return false
    }

    // Prüfung 1: extensionsUsed listet alle Extensions auf, die IRGENDWO
    // in der Datei vorkommen (aber optional sein können, d.h. ein Viewer
    // könnte sie auch ignorieren). Wenn Draco hier drinsteht, wird es benutzt.
    if (json.extensionsUsed?.includes(DRACO_EXTENSION_NAME)) {
        return true
    }

    // Prüfung 2: extensionsRequired listet Extensions, die ein Viewer
    // UNBEDINGT verstehen muss, um die Datei korrekt darzustellen.
    // Das ist eine strengere Variante von extensionsUsed, aber inhaltlich
    // ebenfalls ein klares Zeichen für Draco-Nutzung.
    if (json.extensionsRequired?.includes(DRACO_EXTENSION_NAME)) {
        return true
    }

    // Prüfung 3: Fallback, falls die Listen oben aus irgendeinem Grund
    // fehlen oder unvollständig sind. Wir schauen direkt in die Geometrie:
    // jedes Mesh besteht aus einer oder mehreren "primitives" (Teilgeometrien),
    // und genau dort setzt Draco-Kompression pro Primitive an.
    for (const mesh of json.meshes || []) {
        for (const primitive of mesh.primitives || []) {
            // Wenn diese Primitive einen Draco-Extension-Eintrag hat,
            // ist sie komprimiert gespeichert (statt als normale Rohdaten-Verweise)
            if (primitive.extensions?.[DRACO_EXTENSION_NAME]) {
                return true
            }
        }
    }

    return false
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
    console.error(`[glb2draco] ${error.message}`)

    if (error.stack) {
        console.error(error.stack)
    }

    process.exit(1)
})