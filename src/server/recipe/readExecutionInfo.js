const fs = require('fs')

// Liest den FAS-Info-Payload entweder aus einer Datei oder direkt aus dem CLI-Argument.
// So koennen alle Rezeptskripte dieselben Metadaten unabhaengig von der Aufrufart verwenden.
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