/* Compile the native Chroma isolator and run only its zero-write self-test. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const{execFile}=require('node:child_process');
const{promisify}=require('node:util');
const run=promisify(execFile);

async function main(){
  if(process.platform!=='win32')throw new Error('This check needs the Windows .NET Framework C# compiler.');
  const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const source=path.resolve(__dirname,'../tools/NativeChromaDiagnostic.cs');
  const directory=path.resolve(__dirname,'../.artifacts/lighting-lab');
  const executable=path.join(directory,'NativeChromaDiagnostic.exe');
  await fs.mkdir(directory,{recursive:true});
  await run(compiler,['/nologo','/platform:x64','/target:exe',`/out:${executable}`,source],{windowsHide:true,timeout:20000});
  const checked=JSON.parse((await run(executable,['--self-test'],{windowsHide:true,timeout:10000})).stdout);
  assert.equal(checked.ok,true);assert.equal(checked.nativeCalls,0);assert.equal(checked.rgbWrites,0);
  assert.equal(checked.effect,'solid-lime-keyboard-only');
  process.stdout.write(JSON.stringify({ok:true,artifact:executable,...checked})+'\n');
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
