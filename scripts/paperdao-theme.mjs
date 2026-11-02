import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

// One-time CSS-only recolor. Geometry, selectors and all non-color values stay intact.
const roots = [resolve("../gmgn-sniper"), resolve(".")];
mkdirSync("evidence", { recursive: true });
const palette = {
  "--bg":"#f4ecd8", "--text":"#2b2924", "--panel":"#faf5e9",
  "--panel-raised":"#fffaf0", "--line":"#cec7b6", "--muted":"#746d61",
  "--accent":"#8b2020", "--green":"#247453", "--red":"#b73737",
  "--surface-input":"#f1e8d3", "--terminal-bg":"#f4ecd8",
  "--terminal-border":"#cec7b6", "--terminal-blue":"#8b2020",
  "--terminal-green":"#247453", "--log-cyan":"#8b2020",
  "--log-border":"#cec7b6", "--log-muted":"#746d61",
};
const retained = new Set([
  ...Object.values(palette),"#89661a","#956218","#795f9c","#eee2c9",
  "#655943","#ddcfb6","#bd4b42","#f3e1cd","#9f3d36","#f1e7d0",
  "#fff8e8","#d9d3c6","#38846c","#ddd6c8","#c8392b",
]);
const token = /#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b|rgba?\([^)]*\)/gi;
function decode(hex) {
  let s=hex.slice(1); if(s.length===3||s.length===4)s=[...s].map(c=>c+c).join("");
  const [r,g,b]=[0,2,4].map(i=>parseInt(s.slice(i,i+2),16)/255);
  const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;
  let h=d===0?0:max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;
  h=(h*60+360)%360;
  return {h,s:max?d/max:0,v:max,alpha:s.length===8?parseInt(s.slice(6),16)/255:1};
}
function recolor(raw,prop) {
  const c=raw.toLowerCase();
  if(!c.startsWith("#")||retained.has(c))return raw;
  const {h,s,v,alpha}=decode(c);
  if(s<0.1 && (alpha<1||v<0.1))return raw; // neutral shadows/overlay
  const family=s<0.15?"neutral":h>=70&&h<170?"green":h>=330||h<18?"red":h>=18&&h<70?"gold":h>=255&&h<330?"purple":"blue";
  const ink={green:"#247453",red:"#b73737",gold:"#89661a",purple:"#795f9c",blue:"#8b2020",neutral:"#2b2924"};
  const tint={green:"#e5eee2",red:"#f3e1d8",gold:"#eee2c9",purple:"#eee5ec",blue:"#f1e8d3",neutral:"#faf5e9"};
  let out;
  if(prop.includes("shadow"))out=family==="neutral"?"#2b2924":ink[family];
  else if(prop==="background"||prop==="background-color"||prop==="background-image")out=tint[family];
  else if(prop.startsWith("border")||prop.startsWith("outline")||prop==="scrollbar-color")out=s>0.6&&v>0.5?ink[family]:"#cec7b6";
  else if(prop==="color"||prop==="fill"||prop==="stroke"||prop==="accent-color")out=(family==="blue"&&s<0.48)?(v>0.85?"#2b2924":"#746d61"):ink[family];
  else return raw;
  return alpha<1?out+Math.round(alpha*255).toString(16).padStart(2,"0"):out;
}
const normalize = css => css.replace(token,"<color>").replace(/hsl\(var\(--avatar-hue, 200\) 26% (21|88)%\)/g,"<avatar-color>").replace(/color-scheme:\s*(dark|light)/g,"color-scheme:<scheme>");
const changes=[];
for(let i=0;i<roots.length;i++) {
  const target=resolve(roots[i],"public/style.css"), before=readFileSync(target,"utf8");
  const backup=resolve(`evidence/paperdao-theme-before-${i===0?"bot-b":"kronos"}.css`);
  if(existsSync(backup))throw Error("BEFORE_SNAPSHOT_ALREADY_EXISTS");
  writeFileSync(backup,before);
  let after=before.replace(/([\w-]+)(\s*:\s*)([^;{}]+)(?=;)/g,(all,prop,space,value)=>{
    if(prop==="color-scheme")return prop+space+value.replace("dark","light");
    if(palette[prop])return prop+space+value.replace(token,palette[prop]);
    return prop+space+value.replace(token,raw=>recolor(raw,prop));
  }).replaceAll("hsl(var(--avatar-hue, 200) 26% 21%)","hsl(var(--avatar-hue, 200) 26% 88%)");
  assert.equal(normalize(after),normalize(before),"Only color values may change");
  changes.push({target,before,after});
}
for(const c of changes)writeFileSync(c.target,c.after);
console.log(JSON.stringify({cssOnly:true,source:"https://www.paperdao.xyz/",palette,files:changes.map(c=>({path:c.target,changed:c.before!==c.after}))}));
