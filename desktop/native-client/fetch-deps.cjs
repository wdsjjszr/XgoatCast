// Pinned official dependencies, verified before extraction/use.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const dir=path.join(__dirname,'deps');
async function download(url,name,expected){
  const file=path.join(dir,name);
  if(!fs.existsSync(file)){
    console.log('Downloading '+name);
    let bytes;
    for(let attempt=1;attempt<=3;attempt++){
      try{
        const response=await fetch(url);if(!response.ok)throw Error('Download failed: '+response.status);
        bytes=Buffer.from(await response.arrayBuffer());break;
      }catch(error){
        if(!(error instanceof TypeError)||attempt===3)throw error;
        console.warn(`Network download failed for ${name}; retrying (${attempt}/2).`);
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    fs.writeFileSync(file,bytes);
  }
  const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(expected&&hash!==expected)throw Error('Checksum mismatch: '+name+'; remove this file and retry.');
  return file;
}
async function main(){
  fs.mkdirSync(dir,{recursive:true});
  const zip=await download('https://download.agora.io/sdk/release/Shengwang_Native_SDK_for_Windows_v4.6.2_FULL.zip','agora-4.6.2.zip','fecad7d6b3f6a647e04408dc7a23401098ab80d8a96bbf504b0c5d2062e5e5c9');
  const dest=path.join(dir,'agora');fs.mkdirSync(dest,{recursive:true});
  if(process.platform==='win32')execFileSync('tar.exe',['-xf',zip,'-C',dest],{stdio:'inherit'});
  else execFileSync('unzip',['-oq',zip,'-d',dest],{stdio:'inherit'});
  fs.cpSync(path.join(dest,'Shengwang_Native_SDK_for_Windows_FULL','sdk'),path.join(dest,'sdk'),{recursive:true});
  await download('https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp','json.hpp','9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6');
  await download('https://raw.githubusercontent.com/nlohmann/json/v3.11.3/LICENSE.MIT','json-LICENSE.txt');
  console.log('Dependencies ready.');
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={download};
