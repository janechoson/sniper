import {chromium} from "@playwright/test";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve} from "node:path";
import assert from "node:assert/strict";
const browser=await chromium.launch({headless:true,channel:"chrome"});
const reports=[];
mkdirSync("docs/previews/paperdao",{recursive:true});
try {
  for(const [name,root,port,views] of [
    ["bot-b",resolve("../gmgn-sniper"),3000,["overview","positions","history","settings","logs"]],
    ["kronos",resolve("."),3001,["overview","positions","history","settings","logs","statistics"]],
  ]){
    const before=readFileSync(`evidence/paperdao-theme-before-${name}.css`,"utf8"),after=readFileSync(resolve(root,"public/style.css"),"utf8");
    const parser=await browser.newPage();
    const parsed=await parser.evaluate(({before,after})=>{
      function rules(css){const sheet=new CSSStyleSheet();sheet.replaceSync(css);const walk=rs=>Array.from(rs,r=>r.cssRules?{condition:r.conditionText,rules:walk(r.cssRules)}:{selector:r.selectorText,properties:r.style?Array.from(r.style):[],type:r.type});return walk(sheet.cssRules);}
      return {before:rules(before),after:rules(after)};
    },{before,after});
    assert.deepEqual(parsed.after,parsed.before,`${name}: selectors/declarations must stay parseable and unchanged`);
    // A frozen DOM isolates geometry checks from independently changing live data.
    const html=readFileSync(resolve(root,"public/index.html"),"utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"").replace(/<link\b[^>]*>/gi,"");
    const geometry=[];
    for(const width of [1440,1024,390]){
      await parser.setViewportSize({width,height:1050});
      await parser.setContent(html);
      const style=await parser.addStyleTag({content:before});
      const measure=()=>parser.evaluate(()=>Array.from(document.querySelectorAll("body,aside,main,nav,nav button,.view,.terminal-panel,input,select,button")).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,id:e.id,rect:[r.x,r.y,r.width,r.height]};}));
      const old=await measure();
      await style.evaluate((e,css)=>{e.textContent=css;},after);
      assert.deepEqual(await measure(),old,`${name}/${width}: geometry changed`);
      geometry.push({width,identical:true});
    }
    await parser.close();
    const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],mutations=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.route("**/*",r=>{
      const u=new URL(r.request().url());
      if(r.request().method()!=="GET"){mutations.push({path:u.pathname,method:r.request().method()});return r.abort();}
      return u.hostname==="127.0.0.1"&&u.port===String(port)?r.continue():r.abort();
    });
    await page.goto(`http://127.0.0.1:${port}`,{waitUntil:"domcontentloaded"});
    await page.waitForTimeout(1200);
    const palette=await page.evaluate(()=>({bg:getComputedStyle(document.body).backgroundColor,text:getComputedStyle(document.body).color,accent:getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),scheme:getComputedStyle(document.documentElement).colorScheme}));
    assert.equal(palette.bg,"rgb(244, 236, 216)");assert.equal(palette.text,"rgb(43, 41, 36)");assert.equal(palette.accent,"#8b2020");assert.equal(palette.scheme,"light");
    for(const view of views){
      const nav=page.locator(`nav [data-view="${view}"]`);
      if(await nav.count()){await nav.click();await page.waitForTimeout(220);await page.screenshot({path:`docs/previews/paperdao/${name}-${view}-1440.png`,fullPage:true});}
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('nav [data-view="overview"]').click();
    await page.waitForTimeout(180);
    await page.screenshot({path:`docs/previews/paperdao/${name}-overview-390.png`,fullPage:true});
    assert.deepEqual(mutations,[]);assert.deepEqual(errors,[]);
    reports.push({name,palette,geometry,errors,mutations,cssOnly:true});
    await page.close();
  }
  writeFileSync("evidence/paperdao-theme-browser.json",JSON.stringify({at:new Date().toISOString(),reports},null,2));
  console.log("PASS: both live dashboards use PaperDAO colors; CSS selectors/properties and geometry unchanged at 1440/1024/390; no page errors or mutation requests.");
}finally{await browser.close();}
