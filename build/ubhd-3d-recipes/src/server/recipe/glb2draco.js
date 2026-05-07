#!/usr/bin/env node

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { readExecutionInfo } = require('./readExecutionInfo')

const GLB_MAGIC = 0x46546c67
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a
const DRACO_EXTENSION_NAME = 'KHR_draco_mesh_compression'

async function main() {
	const [, , infoArg, sourceUrl, inputFile, outputFile] = process.argv

	if (!infoArg || !inputFile || !outputFile) {
		throw new Error('Usage: node glb2draco.js <info-json-or-path> <source-url> <input.glb> <output.glb>')
	}

	const info = readExecutionInfo(infoArg)
	ensureReadableFile(inputFile, 'input GLB')

	const cliPath = path.resolve(__dirname, '..', '..', '..', 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js')
	const invocation = await getCliInvocation(cliPath)
	const minimumSavingsRatio = getMinimumSavingsRatio()

	await fsp.mkdir(path.dirname(outputFile), { recursive: true })

	const inputStat = await fsp.stat(inputFile)
	const inputJson = await readGlbJson(inputFile)
	const sourceName = sourceUrl || info?._source?.url || inputFile

	if (hasDracoCompression(inputJson)) {
		await fsp.copyFile(inputFile, outputFile)
		console.error(`[glb2draco] Skipped ${sourceName}, input already uses ${DRACO_EXTENSION_NAME}`)
	} else {
		const tempDir = await fsp.mkdtemp(path.join(path.dirname(outputFile), 'glb2draco-'))
		const tempOutputFile = path.join(tempDir, 'model.draco.glb')

		try {
			const args = buildDracoArgs(path.resolve(inputFile), path.resolve(tempOutputFile))
			await runCommand(invocation.command, [...invocation.prefixArgs, ...args])

			const compressedStat = await fsp.stat(tempOutputFile)
			const savingsRatio = inputStat.size > 0 ? (inputStat.size - compressedStat.size) / inputStat.size : 0

			if (compressedStat.size < inputStat.size && savingsRatio >= minimumSavingsRatio) {
				await fsp.copyFile(tempOutputFile, outputFile)
				console.error(`[glb2draco] Accepted compressed output for ${sourceName}`)
			} else {
				await fsp.copyFile(inputFile, outputFile)
				console.error(`[glb2draco] Skipped compression for ${sourceName}, savings were not beneficial`)
			}
		} finally {
			await fsp.rm(tempDir, { recursive: true, force: true })
		}
	}

	const outputStat = await fsp.stat(outputFile)
	if (!outputStat.size) {
		throw new Error(`GLB written but file is empty: ${outputFile}`)
	}

	console.error(`[glb2draco] ${inputStat.size} -> ${outputStat.size} bytes`)
}

function ensureReadableFile(filePath, label) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing ${label}: ${filePath}`)
	}

	fs.accessSync(filePath, fs.constants.R_OK)
}

async function getCliInvocation(cliPath) {
	ensureReadableFile(cliPath, 'gltf-transform CLI')

	try {
		fs.accessSync(cliPath, fs.constants.X_OK)
		return { command: cliPath, prefixArgs: [] }
	} catch (_error) {
		return { command: process.execPath, prefixArgs: [cliPath] }
	}
}

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

function appendOption(args, flag, value) {
	if (value === undefined || value === null || value === '') {
		return
	}

	args.push(flag, String(value))
}

function getMinimumSavingsRatio() {
	const value = Number(process.env.UBHD_GLB2DRACO_MIN_SAVINGS_RATIO ?? 0)

	if (!Number.isFinite(value)) {
		return 0
	}

	return Math.min(Math.max(value, 0), 1)
}

async function readGlbJson(filePath) {
	const fileHandle = await fsp.open(filePath, 'r')

	try {
		const header = Buffer.alloc(20)
		const headerRead = await fileHandle.read(header, 0, header.length, 0)

		if (headerRead.bytesRead < header.length) {
			throw new Error(`GLB header too short: ${filePath}`)
		}

		if (header.readUInt32LE(0) !== GLB_MAGIC) {
			throw new Error(`Invalid GLB magic for ${filePath}`)
		}

		if (header.readUInt32LE(4) !== 2) {
			throw new Error(`Unsupported GLB version for ${filePath}`)
		}

		const jsonChunkLength = header.readUInt32LE(12)
		if (header.readUInt32LE(16) !== GLB_JSON_CHUNK_TYPE) {
			throw new Error(`Missing JSON chunk in ${filePath}`)
		}

		const jsonChunk = Buffer.alloc(jsonChunkLength)
		const jsonRead = await fileHandle.read(jsonChunk, 0, jsonChunkLength, 20)

		if (jsonRead.bytesRead < jsonChunkLength) {
			throw new Error(`Incomplete GLB JSON chunk in ${filePath}`)
		}

		return JSON.parse(jsonChunk.toString('utf8').replace(/\u0000+$/, ''))
	} finally {
		await fileHandle.close()
	}
}

function hasDracoCompression(json) {
	if (!json || typeof json !== 'object') {
		return false
	}

	if (json.extensionsUsed?.includes(DRACO_EXTENSION_NAME)) {
		return true
	}

	if (json.extensionsRequired?.includes(DRACO_EXTENSION_NAME)) {
		return true
	}

	for (const mesh of json.meshes || []) {
		for (const primitive of mesh.primitives || []) {
			if (primitive.extensions?.[DRACO_EXTENSION_NAME]) {
				return true
			}
		}
	}

	return false
}

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
	console.error(`[glb2draco] ${error.message}`)

	if (error.stack) {
		console.error(error.stack)
	}

	process.exit(1)
})