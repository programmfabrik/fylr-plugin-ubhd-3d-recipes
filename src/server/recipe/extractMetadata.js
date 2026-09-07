const fs = require('fs');
const path = require('path');

const inputFile = process.argv[2];
const outputFile = process.argv[3];

console.error("extractMetadata.js: input:", inputFile);
console.error("extractMetadata.js: output:", outputFile);

function readGltfJson(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.glb') {
    // GLB binary format: JSON chunk starts at byte 20
    const buf = fs.readFileSync(file);
    const magic = buf.readUInt32LE(0);
    if (magic !== 0x46546C67) throw new Error('Not a valid GLB file');
    const jsonChunkLength = buf.readUInt32LE(12);
    const jsonChunkType  = buf.readUInt32LE(16);
    if (jsonChunkType !== 0x4E4F534A) throw new Error('First GLB chunk is not JSON');
    return JSON.parse(buf.slice(20, 20 + jsonChunkLength).toString('utf8'));
  } else {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}

function inspect(file) {
  try {
    const gltf = readGltfJson(file);
    const extensions = gltf.extensionsUsed || [];
    // const dracoCompressed = extensions.includes('KHR_draco_mesh_compression');
    let dracoCompressed = null;
    if (extensions.includes('KHR_draco_mesh_compression')) {
      dracoCompressed = 1;
    }
    console.error("extensionsUsed:", extensions);
    return { draco_compressed: dracoCompressed };
  } catch (err) {
    console.error('Error inspecting file:', err.message);
    return { draco_compressed: null, error: err.message };
  }
}

const metadata = {
  "_technical_metadata": {
    "UBHD_3D_GLB_COMPRESSED": inspect(inputFile)
  }
};

fs.writeFileSync(outputFile, JSON.stringify(metadata));