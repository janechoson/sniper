import {chromium} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
const browser=await chromium.launch({headless:true,channel:"chrome"});
mkdirSync('docs/previews/screen-parity',{recursive:true});
const records=[];
const label=process.argv[2]||'before';
try{
  for(const [name,port] of [['bot-b',3000],['kronos-'+label,3001]]){
    const page=await browser.newPage({viewport:{width:1440,height:1050}});
    const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.route('**/*',r=>{const u=new URL(r.request().url());return r.request().method()==='GET'&&u.hostname==='127.0.0.1'&&u.port===String(port)?r.continue():r.abort();});
    await page.goto(`http://127.0.0.1:${port}/`);await page.waitForSelector('.central-token');
    for(const view of ['positions','history','logs','settings']){
      await page.locator(`nav [data-view="${view}"]`).click();await page.waitForTimeout(350);
      await page.screenshot({path:`docs/previews/screen-parity/${name}-${view}.png`,fullPage:true});
      records.push({name,view,errors:[...errors],heading:await page.locator(`#${view} h2`).first().textContent(),geometry:await page.locator(`#${view}`).boundingBox()});
    }
    await page.close();
  }
  writeFileSync('evidence/ui-screen-parity-'+label+'.json',JSON.stringify(records,null,2));
  console.log('Captured four BOT B and four Kronos screens using GET-only browser requests.');
}finally{await browser.close();}
