const fs = require('fs')


/**
 * Liest den FAS-Info-Payload entweder aus einer Datei oder direkt aus dem CLI-Argument.
 * So können alle Rezeptskripte dieselben Metadaten unabhängig von der Aufrufart verwenden.
 * 
 * @param {string} infoArg - Pfad zu einer JSON-Datei mit Metadaten (oder direkt JSON-String)
 * @returns {object} - Parsed JSON object containing execution info
 * @throws {Error} - If the infoArg is missing or cannot be parsed
 */
function readExecutionInfo(infoArg) {
	if (!infoArg) {
		throw new Error('Missing info.json payload')
	}

	if (fs.existsSync(infoArg)) {
		return JSON.parse(fs.readFileSync(infoArg, 'utf8'))
	}

	try {
		return JSON.parse(infoArg)
	} catch (_error) {
		throw new Error(`Missing info.json: ${infoArg}`)
	}
}

module.exports = {
	readExecutionInfo
}