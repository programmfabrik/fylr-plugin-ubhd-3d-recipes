const fs = require('fs');

const { execSync } = require('child_process')

console.error("Extract metadata failed.")
console.error("process.argv[0]." + process.argv[0])
console.error("process.argv[1]." + process.argv[1])
console.error("process.argv[2]." + process.argv[2])

function inspect(file) {
  try {
    const output = execSync(`gltf-transform inspect ${file} | grep KHR_draco`, { encoding: 'utf-8' });
    return {
            "compressed": true
        };
  } catch (error) {
    if (error.status === 1) {
      console.log('KHR_draco extension not found.');
      return {
            "compressed": false
        };
    } else {
      console.error('An error occured:', error.message);
    }
}}

const metadata = {
    "_technical_metadata": {
        "UBHD_3D_Recipes": inspect(process.argv[2])
    }
}

fs.writeFileSync(process.argv[3], JSON.stringify(metadata))

// fs.writeFileSync(process.argv[2], fs.readFileSync(process.argv[1], 'utf8').replaceAll('_custom_', '%custom%'));