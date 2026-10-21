import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ns = (ms:number) => String(BigInt(ms)*1_000_000n);
const markets = Array.from({length:53},(_,i)=>({id:String(i),title:`Market ${i}: will the project reach its next milestone?`,rule_text:"Yes if the published milestone is completed by the deadline.",resolution_source:"https://example.org/result",void_policy:"Cancelled if the source becomes unavailable.",category:"tech",subcategory:"ai",rule_hash:"a".repeat(64),close_at:ns(Date.now()+86400000),resolve_by:ns(Date.now()+172800000),status:"open",registered:true,seeded:true,outcome:null,price_yes:"600000",price_no:"400000",locked:String((1000-i)*1000000)}));

test.beforeEach(async ({ page }) => {
  await page.route("**/local-rpc", async route => {
    const request=route.request().postDataJSON();
    const {method_name:name,args_base64:args64}=request.params;
    const args=JSON.parse(Buffer.from(args64,"base64").toString());
    let value:unknown=null;
    if(name==="list_markets") value=markets.slice(Number(args.from_index),Number(args.from_index)+Number(args.limit));
    if(name==="get_market") value=markets.find(m=>m.id===args.market_id)??null;
    if(name==="get_balance"||name==="ft_balance_of") value="10000000";
    if(name==="get_shares") value=["1000000","0"];
    if(name==="get_history") value=[{at:ns(Date.now()-60000),price_yes:500000},{at:ns(Date.now()),price_yes:600000}];
    await route.fulfill({json:{jsonrpc:"2.0",id:request.id,result:{result:[...Buffer.from(JSON.stringify(value))]}}});
  });
});

test("all markets load, with at most five history reads per refresh",async({page})=>{
  let histories=0;
  page.on("request",r=>{if(r.url().endsWith("/local-rpc")&&r.postDataJSON()?.params?.method_name==="get_history")histories++;});
  await page.goto("/");
  await expect(page.getByTestId("market-card").first()).toBeVisible();
  while(await page.getByRole("button",{name:/Show More/}).count())await page.getByRole("button",{name:/Show More/}).click();
  await expect(page.getByTestId("market-card")).toHaveCount(53);
  expect(histories).toBeLessThanOrEqual(5);
});

test("placeholder ticket makes no quote or transaction request",async({page})=>{
  const calls:string[]=[];
  page.on("request",r=>{if(r.url().endsWith("/local-rpc"))calls.push(r.postDataJSON()?.params?.method_name);});
  await page.goto("/market?id=0");
  await page.getByLabel("Amount",{exact:true}).fill("10");
  await expect(page.getByRole("button",{name:"Trading coming soon"})).toBeDisabled();
  await expect(page.getByText("Not available yet",{exact:true})).toBeVisible();
  expect(calls.some(c=>/quote_buy|quote_sell|broadcast/.test(c))).toBe(false);
});

test("Council has a complete green palette, shared fonts and responsive Dragons Market branding",async({page})=>{
  for(const theme of ["dark","light"]){
    await page.goto("/");
    await page.evaluate(t=>{localStorage.setItem("council-theme",t);document.documentElement.dataset.theme=t;window.dispatchEvent(new Event("theme-change"));},theme);
    const venueBg=await page.evaluate(()=>getComputedStyle(document.body).backgroundColor);
    const font=await page.getByRole("heading",{level:1}).evaluate(e=>getComputedStyle(e).fontFamily);
    const main=page.getByRole("navigation",{name:"Main",exact:true}).filter({visible:true});
    await main.getByRole("link",{name:"Council",exact:true}).click();
    await expect(page.locator("html")).toHaveAttribute("data-palette","council");
    await expect(page.getByRole("heading",{level:1})).toHaveText("Dragon Council");
    expect(await page.getByRole("heading",{level:1}).evaluate(e=>getComputedStyle(e).fontFamily)).toBe(font);
    expect(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).not.toBe(venueBg);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content",theme==="dark"?"#070d0a":"#f4faf6");
    expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--raised").trim())).toBe(theme==="dark"?"#14221a":"#e6f1e9");
    await expect(page.getByRole("link",{name:"Dragons Market home"})).toHaveCount(2);
    await expect(page.locator(".site-brand .brand-mark")).toHaveCount(2);
    expect(await page.locator(".brand-mark").first().evaluate(e=>getComputedStyle(e).maskImage)).toContain("/brand/dragon-crest.png");
    expect((await page.request.get("/brand/dragon-crest.png")).ok()).toBe(true);
    await expect(page.locator('link[rel="icon"][href="/brand/dragon-favicon.svg"]')).toHaveCount(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
    const results=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21aa","wcag22aa"]).analyze();
    expect(results.violations).toEqual([]);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-palette","council");
    await page.getByRole("button",{name:`Switch to ${theme==="dark"?"light":"dark"} theme`}).click();
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content",theme==="dark"?"#f4faf6":"#070d0a");
    await page.getByRole("button",{name:`Switch to ${theme} theme`}).click();
    await main.getByRole("link",{name:"Markets",exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).toBe(venueBg);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content",theme==="dark"?"#0b080e":"#fbfafc");
  }
});


test("portfolio writes remain disabled until the final withdrawal flow is wired",async({page})=>{
  await page.goto("/portfolio?as=review-account.test.near");
  await expect(page.getByRole("button",{name:"Withdrawals coming soon"})).toBeDisabled();
  await expect(page.getByText("53 positions",{exact:true})).toBeVisible();
});

test("explicitly unseeded detail is not presented as a tradable market",async({page})=>{
  await page.route("**/local-rpc",async route=>{
    const request=route.request().postDataJSON();
    if(request.params.method_name!=="get_market")return route.fallback();
    await route.fulfill({json:{jsonrpc:"2.0",id:request.id,result:{result:[...Buffer.from(JSON.stringify({...markets[0],seeded:false}))]}}});
  });
  await page.goto("/market?id=0");
  await expect(page.getByText("This market is not ready for trading.",{exact:false})).toBeVisible();
  await expect(page.locator('[aria-label="Trade ticket"]')).toHaveCount(0);
});

test("sports artwork follows the theme and final rulings use Council typography", async ({page}) => {
  const sports = ["nba", "mlb", "nfl", "soccer"];
  await page.route("**/local-rpc", async route => {
    const request = route.request().postDataJSON();
    const { method_name: name, args_base64: args64 } = request.params;
    const args = JSON.parse(Buffer.from(args64, "base64").toString());
    let value: unknown;
    if (name === "list_markets") value = markets.map((m, i) => i < 4 ? {...m, category: "sports", subcategory: sports[i]} : m).slice(Number(args.from_index), Number(args.from_index) + Number(args.limit));
    else if (name === "get_market") value = {...markets[0], status: "resolved", outcome: "no"};
    else if (name === "get_case") value = {stage: "final", proposed: "yes", final_outcome: "no", evidence: "https://example.org/result", votes: [], applied: true};
    else return route.fallback();
    await route.fulfill({json: {jsonrpc: "2.0", id: request.id, result: {result: [...Buffer.from(JSON.stringify(value))]}}});
  });
  for (const theme of ["dark", "light"]) {
    await page.goto("/");
    await page.evaluate(t => { localStorage.setItem("council-theme", t); document.documentElement.dataset.theme = t; window.dispatchEvent(new Event("theme-change")); }, theme);
    const icon = page.getByTestId("market-card").first().locator(".market-icon");
    await expect(icon).toBeVisible();
    const paints = await page.getByTestId("market-card").locator('.market-icon svg [fill], .market-icon svg [stroke]').evaluateAll(elements => elements.flatMap(e => [e.getAttribute("fill"), e.getAttribute("stroke")].filter(Boolean)));
    expect(paints.some(p => /^#/.test(p!))).toBe(false);
    const active = page.locator('.featured-carousel-controls button[aria-pressed="true"]').first();
    await expect(active).toBeVisible();
    expect(await active.evaluate(e => {
      const probe = document.createElement("span"); probe.style.color = "var(--brand)"; e.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return getComputedStyle(e).color === expected;
    })).toBe(true);
    await page.goto("/market?id=0");
    const verdict = page.locator(".resolution-verdict");
    await expect(verdict).toHaveText("Final answer: No");
    // v2 sets final rulings in the engraved display face (Gloock), still in the Council colour.
    expect(await verdict.evaluate(e => getComputedStyle(e).fontFamily)).toContain("Gloock");
    expect(await verdict.evaluate(e => {
      const probe = document.createElement("span"); probe.style.color = "var(--council)"; e.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return getComputedStyle(e).color === expected;
    })).toBe(true);
  }
});
