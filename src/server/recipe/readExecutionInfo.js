const fs = require('fs')

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