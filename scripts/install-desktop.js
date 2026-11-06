import {readFile,writeFile,mkdir,copyFile,rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const profile=join(process.env.DSH_HOME || join(homedir(),'.dsh'),'profiles','desktop');
const file=join(profile,'cordis.patch.yml');
const before=await readFile(file,'utf8');
const id='codex-desktop-bridge';
if(before.includes('id: '+id)) {console.log('Desktop bridge is already configured.');process.exit(0);}
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backup=join(root,'.local','desktop-install-'+stamp);
await mkdir(backup,{recursive:true});await copyFile(file,join(backup,'cordis.patch.yml'));
const plugin=pathToFileURL(join(root,'src','desktop-plugin.js')).href;
const patch='\n- insert:\n    - id: '+id+'\n      name: '+JSON.stringify(plugin)+'\n      config:\n        dataDir: '+JSON.stringify(join(root,'.bridge'))+'\n        provider: deepseek-account\n        model: deepseek-flash\n';
await writeFile(file+'.bridge-tmp',before+patch);await rename(file+'.bridge-tmp',file);
console.log('Desktop bridge configured. Backup: '+backup);
