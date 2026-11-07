import { expect, test } from '@playwright/test';
import { linkUi, startHarness, type Harness } from './helpers.js';

let h: Harness;
let unlink: () => void;
test.beforeAll(() => { unlink = linkUi(); });
test.afterAll(() => unlink());
test.afterEach(async ({page}) => { await page.close(); await h?.close(); });

test('review marks survive reopening and clear when a patch changes without changing its counts', async ({page}) => {
  let changed = false;
  h = await startHarness('review', {routes:{
    'POST /v1/git/status': () => ({json:{repository:'/repo',branch:'feature',files:[{path:'a.ts',status:'M',staged:false,additions:1,deletions:1}]}}),
    'POST /v1/diff': () => ({json:{root:'/repo',files:[{path:'a.ts',status:'M',sections:[{kind:'unstaged',patch:`@@ -1 +1 @@\n-old\n+${changed ? 'NEW' : 'new'}\n`}]}]}}),
  }});
  await page.goto(h.url,{waitUntil:'domcontentloaded'});
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator('.sb-row',{hasText:'Fix login'}).click();
  await expect(page.locator('.chg-review-bar')).toContainText('0 of 1 reviewed');
  await page.getByRole('button',{name:'Mark file reviewed',exact:true}).click();
  await expect(page.locator('.chg-review-bar')).toContainText('1 of 1 reviewed');
  await page.reload();
  await expect(page.locator('.chg-review-bar')).toContainText('1 of 1 reviewed');
  changed = true;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('phren:git-changed',{detail:{computer:'This computer',session:'sess-fix-login'}})));
  await expect(page.locator('.chg-review-bar')).toContainText('0 of 1 reviewed');
});

test('notes from both sides of a diff go to the agent in one prompt', async ({page}) => {
  h = await startHarness('diff-notes');
  await page.goto(h.url,{waitUntil:'domcontentloaded'});
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator('.sb-row',{hasText:'Fix login'}).click();
  await page.locator('.chg-row',{hasText:'app.ts'}).first().hover();
  await page.locator('.chg-row',{hasText:'app.ts'}).first().getByTitle('Preview diff and add notes').click();
  for (const side of ['old','new']) {
    await page.getByRole('button',{name:new RegExp(`Add note on src/app.ts:1 \\(${side} side\\)`)}).click();
    const dialog = page.getByRole('dialog',{name:'Note on diff line'});
    await dialog.getByRole('textbox').fill(`Check the ${side} version.`);
    await dialog.getByRole('button',{name:'Save note'}).click();
  }
  await page.locator('.chg').getByRole('button',{name:'2 notes · Send to agent',exact:true}).click();
  await expect.poll(() => h.hook.calls.filter(c => c.path === '/v1/prompt').length).toBe(1);
  const body = h.hook.calls.find(c => c.path === '/v1/prompt')!.body as {text:string;deliveryId:string;target:{session:string}};
  expect(body.target.session).toBe('sess-fix-login');
  expect(body.deliveryId).toBeTruthy();
  expect(body.text).toContain('Notes on the code:');
  expect(body.text).toContain('`src/app.ts:1 (old side)`');
  expect(body.text).toContain('`src/app.ts:1 (new side)`');
  await expect(page.locator('.chg-notes-tray')).toBeEmpty();
});
