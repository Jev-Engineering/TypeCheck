async (page) => {
    const checks = [], errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const open = async () => {
        await page.goto('http://host.docker.internal:4193');
        await page.getByRole('button', { name: 'Open offline integration test', exact: true }).click();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page.getByRole('heading', { name: 'Optional data use', exact: true }).waitFor();
    };
    const review = () => page.getByRole('checkbox', { name: /^Allow TypeSafe to review/ });
    const training = () => page.getByRole('checkbox', { name: /^Allow CompleteTech LLC/ });
    const save = async () => {
        await page.getByRole('button', { name: 'Save data-use choices', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'Data-use choices saved.' }).waitFor();
    };
    const state = async (a, b) => {
        if (await review().isChecked() !== a || await training().isChecked() !== b) throw Error('Unexpected checkbox values');
    };
    await page.setViewportSize({ width: 1440, height: 1050 });
    await open(); await state(false, false);
    checks.push('Desktop: both optional choices initially off, labels discoverable by accessible name');
    const panel = page.getByRole('heading', { name: 'Optional data use', exact: true }).locator('xpath=ancestor::section');
    const text = await panel.innerText();
    for (const required of ['entire organization', 'cannot change or verify', 'does not override', 'without either opt-in', '2026-10-17.1', 'rights or consent']) if (!text.includes(required)) throw Error('Missing notice: ' + required);
    checks.push('Rendered provider-scope, optionality, notice-version and affected-person authorization warnings');
    await review().focus(); await page.keyboard.press('Space'); await state(true, false); await save();
    if (!await page.getByRole('status').evaluate(el => document.activeElement === el)) throw Error('Saved feedback not focused');
    checks.push('Keyboard Space changes review only; explicit save has focused status feedback');
    await training().check(); await save(); await open(); await state(true, true);
    checks.push('Both independently enabled and persisted after page reload/reconnect');
    await review().uncheck(); await save(); await state(false, true);
    await panel.screenshot({ path: '/output/desktop.png' });
    checks.push('Desktop withdrawal preserves training permission');
    for (const conflict of ['revision', 'noticeVersion']) {
        const route = '**/api/g/*/settings';
        await page.route(route, async r => {
            if (r.request().method() !== 'PUT') return r.continue();
            const body = r.request().postDataJSON();
            body[conflict] = conflict === 'revision' ? 0 : 'old-notice';
            // Revision 1 is valid but stale; 0 would test validation instead of a conflict.
            if (conflict === 'revision') body.revision = 1;
            await r.continue({ postData: JSON.stringify(body) });
        });
        await review().check();
        await page.getByRole('button', { name: 'Save data-use choices', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'Choices were not saved' }).waitFor();
        if (!await page.getByRole('status').evaluate(el => document.activeElement === el)) throw Error('Conflict feedback not focused');
        await page.unroute(route); await open(); await state(false, true);
        checks.push(conflict + ' conflict: truthful reload instruction, focused feedback, no persisted change');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await training().uncheck(); await save(); await open(); await state(false, false);
    await training().check(); await save(); await open(); await state(false, true);
    await training().uncheck(); await save(); await state(false, false);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Mobile document overflow');
    await panel.screenshot({ path: '/output/mobile.png' });
    checks.push('390px mobile: independent save/readback/withdrawal and no document overflow');
    for (const path of ['/privacy', '/terms']) {
        await page.goto('http://host.docker.internal:4193' + path);
        const body = await page.locator('body').innerText();
        if (!body.includes('CompleteTech LLC') || !body.includes('TypeSafe')) throw Error('Missing identities on ' + path);
    }
    checks.push('Served privacy and terms identify host/provider');
    if (errors.length) throw Error(errors.join('\n'));
    return { provenance: 'Compiled Activity + actual HTTP handlers; synthetic Discord/provider adapters; isolated in-memory store. No live acceptance claimed.', viewports: ['1440x1050', '390x844'], checks, pageErrors: errors };
}
