#!/usr/bin/env node

/**
 * Showcase Mode capture driver.
 *
 * Shoots every entry in `shots.js`, in every requested theme, without a human
 * clicking through them. One launch PER THEME: the theme is applied by seeding
 * `maestro-settings.json` before the app starts, which is the only way to be
 * sure every surface has painted in that theme by the time the shutter opens.
 * Switching live would leave a repaint race on exactly the surfaces (charts,
 * the Cue canvas) that are slowest and most worth photographing.
 *
 * Two channels, deliberately:
 *   - The WS bridge opens each surface, because that is the same `open_modal`
 *     path `maestro-cli open` uses. It honors Encore gating and the modal layer
 *     stack, so a shot can never capture a state a user could not reach.
 *   - CDP only takes the picture (`Page.captureScreenshot`). It never drives
 *     navigation, so this script cannot drift from what the app supports.
 *
 * Usage:
 *   node scripts/showcase/capture.js [--themes a,b,c] [--size WxH]
 *                                    [--only name,name] [--out <dir>]
 *                                    [--cwd <path>] [--keep]
 *
 * Output lands at `<out>/<shot name>.<theme id>.png`, so a docs page or the
 * website gallery can swap themes by substituting one path segment.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const WebSocket = require('ws');

const { SHOWCASE_DIR } = require('./showcase-dir');
const { SHOTS, SETTLE_MS } = require('./shots');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_THEMES = ['dracula', 'catppuccin-latte', 'pedurple'];
const DEFAULT_SIZE = '1796x1151';
const DEFAULT_OUT = path.join(ROOT, 'docs', 'screenshots');
const CDP_PORT = process.env.MAESTRO_CDP_PORT || '17399';
/** How long to wait for the app to boot far enough to answer CDP. */
const BOOT_TIMEOUT_MS = 120000;
/**
 * How long to wait for the shell to PAINT after it answers, which is a longer
 * and separate budget: the first theme of a run pays for a cold
 * `tsc -p tsconfig.main.json` before Electron even starts, and the splash is
 * already serving CDP throughout that compile.
 */
const PAINT_TIMEOUT_MS = 240000;

// --- CLI args ---------------------------------------------------------------

function argValue(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const themes = argValue('themes', DEFAULT_THEMES.join(',')).split(',').filter(Boolean);
const size = argValue('size', DEFAULT_SIZE);
const outDir = path.resolve(argValue('out', DEFAULT_OUT));
const only = argValue('only', '').split(',').filter(Boolean);
const keepRunning = hasFlag('keep');
/** Forwarded to setup.js: the working directory the shots publish. See setup.js. */
const demoCwd = argValue('cwd', '');

const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
if (!shots.length) {
	console.error(`[capture] No shots matched --only ${only.join(',')}`);
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- WS bridge (opens surfaces) ---------------------------------------------

/**
 * Read the running app's CLI discovery file. Written into the app's OWN
 * userData dir, which in showcase mode is SHOWCASE_DIR, so this reaches the
 * showcase instance rather than whatever production app is also running.
 */
function readBridgeInfo() {
	const file = path.join(SHOWCASE_DIR, 'cli-server.json');
	if (!fs.existsSync(file)) return null;
	try {
		const info = JSON.parse(fs.readFileSync(file, 'utf8'));
		return info && info.port && info.token ? info : null;
	} catch {
		return null; // half-written file; the caller retries
	}
}

class Bridge {
	constructor(info) {
		this.url = `ws://127.0.0.1:${info.port}/${info.token}/ws`;
		this.pending = new Map();
		this.seq = 0;
	}

	connect() {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url, { perMessageDeflate: false });
			this.ws.on('open', () => resolve());
			this.ws.on('error', reject);
			this.ws.on('message', (raw) => {
				let msg;
				try {
					msg = JSON.parse(raw.toString());
				} catch {
					return;
				}
				const pending = msg.requestId && this.pending.get(msg.requestId);
				if (pending) {
					this.pending.delete(msg.requestId);
					pending(msg);
				}
			});
		});
	}

	send(message, expectType, timeoutMs = 15000) {
		const requestId = `cap_${++this.seq}_${Date.now()}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error(`timed out waiting for ${expectType}`));
			}, timeoutMs);
			this.pending.set(requestId, (msg) => {
				clearTimeout(timer);
				resolve(msg);
			});
			this.ws.send(JSON.stringify({ ...message, requestId }));
		});
	}

	close() {
		try {
			this.ws && this.ws.close();
		} catch {
			/* already gone */
		}
	}
}

// --- CDP (takes the picture) ------------------------------------------------

class Cdp {
	constructor(port) {
		this.port = port;
		this.id = 0;
		this.pending = new Map();
	}

	async connect() {
		const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
		const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
		if (!page) throw new Error('no CDP page target');
		await new Promise((resolve, reject) => {
			this.ws = new WebSocket(page.webSocketDebuggerUrl, {
				perMessageDeflate: false,
				maxPayload: 256 * 1024 * 1024,
			});
			this.ws.on('open', resolve);
			this.ws.on('error', reject);
			this.ws.on('message', (raw) => {
				const msg = JSON.parse(raw.toString());
				const pending = msg.id && this.pending.get(msg.id);
				if (pending) {
					this.pending.delete(msg.id);
					pending(msg);
				}
			});
		});
	}

	send(method, params) {
		const id = ++this.id;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	async evaluate(expression) {
		const res = await this.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		});
		return res.result && res.result.result ? res.result.result.value : undefined;
	}

	/**
	 * Wait until the app has actually PAINTED, not merely until it answers.
	 *
	 * The bridge file and the CDP page target both exist while `index.html` is
	 * still showing its splash, so a readiness check built on those alone shoots
	 * the "Tuning instruments..." screen and files it as the hero. Two conditions
	 * have to hold: the splash is gone or hidden, and the Left Bar header has
	 * rendered (the last thing to arrive, since it waits on the session load).
	 */
	async awaitRendered(timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const ready = await this.evaluate(
				`(() => {
				const splash = document.querySelector('#initial-splash');
				const splashGone = !splash || splash.classList.contains('hidden');
				const shell = document.querySelector('[data-testid="sidebar-header-indicators"]');
				return Boolean(splashGone && shell);
			})()`
			).catch(() => false);
			if (ready) return;
			await new Promise((r) => setTimeout(r, 1000));
		}
		// Say what was actually on screen. "Still on the splash" and "painted but
		// the Left Bar never arrived" have different causes, and a bare timeout
		// sends the next person to look in the wrong place.
		const seen = await this.evaluate(
			`(() => {
				const splash = document.querySelector('#initial-splash');
				return JSON.stringify({
					splash: splash ? (splash.classList.contains('hidden') ? 'hidden' : 'visible') : 'absent',
					shell: Boolean(document.querySelector('[data-testid="sidebar-header-indicators"]')),
					title: document.title,
				});
			})()`
		).catch(() => '<could not evaluate>');
		throw new Error(`app never painted after ${timeoutMs / 1000}s: ${seen}`);
	}

	async screenshot(file) {
		const res = await this.send('Page.captureScreenshot', { format: 'png' });
		if (!res.result || !res.result.data) throw new Error('empty screenshot');
		fs.writeFileSync(file, Buffer.from(res.result.data, 'base64'));
	}

	/**
	 * Press Escape. There is no `close_modals` bridge verb, and there should not
	 * be one: Escape is how a user leaves a layer, so pressing it exercises the
	 * same layer-stack path rather than a back door that could drift from it.
	 * Sent twice in case a surface has a nested layer open above it.
	 */
	async escape() {
		for (let i = 0; i < 2; i++) {
			await this.send('Input.dispatchKeyEvent', {
				type: 'keyDown',
				key: 'Escape',
				code: 'Escape',
				windowsVirtualKeyCode: 27,
				nativeVirtualKeyCode: 27,
			});
			await this.send('Input.dispatchKeyEvent', {
				type: 'keyUp',
				key: 'Escape',
				code: 'Escape',
				windowsVirtualKeyCode: 27,
				nativeVirtualKeyCode: 27,
			});
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	close() {
		try {
			this.ws && this.ws.close();
		} catch {
			/* already gone */
		}
	}
}

// --- app lifecycle ----------------------------------------------------------

function seedFor(theme) {
	console.log(`[capture] Seeding ${theme}...`);
	const args = [path.join(__dirname, 'setup.js'), '--theme', theme, '--size', size];
	if (demoCwd) args.push('--cwd', demoCwd);
	execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
}

function launchApp() {
	const child = spawn('npm', ['run', 'dev'], {
		cwd: ROOT,
		env: { ...process.env, MAESTRO_DEMO_DIR: SHOWCASE_DIR, MAESTRO_CDP_PORT: CDP_PORT },
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: true,
		detached: true,
	});
	// Keep the pipes drained; a full buffer would stall the dev server.
	child.stdout.on('data', () => {});
	child.stderr.on('data', () => {});
	return child;
}

/** Wait for BOTH channels: the app answers CDP and has written its bridge file. */
async function waitForApp() {
	const deadline = Date.now() + BOOT_TIMEOUT_MS;
	let lastErr = 'not started';
	while (Date.now() < deadline) {
		await sleep(2000);
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
			const list = await res.json();
			if (!list.some((t) => t.type === 'page')) {
				lastErr = 'no page target yet';
				continue;
			}
		} catch (e) {
			lastErr = `CDP not up (${e.message})`;
			continue;
		}
		if (!readBridgeInfo()) {
			lastErr = 'bridge file not written yet';
			continue;
		}
		return;
	}
	throw new Error(`app did not come up within ${BOOT_TIMEOUT_MS / 1000}s: ${lastErr}`);
}

function killApp(child) {
	if (!child || child.killed) return;
	try {
		// Negative pid kills the whole process group: `npm run dev` spawns vite
		// and electron as children, and killing only npm orphans both.
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		try {
			child.kill('SIGTERM');
		} catch {
			/* already gone */
		}
	}
}

// --- capture ----------------------------------------------------------------

async function captureTheme(theme) {
	seedFor(theme);
	const app = launchApp();
	let bridge = null;
	let cdp = null;
	const failures = [];

	try {
		console.log('[capture] Waiting for the app...');
		await waitForApp();

		bridge = new Bridge(readBridgeInfo());
		await bridge.connect();
		cdp = new Cdp(CDP_PORT);
		await cdp.connect();
		await cdp.send('Runtime.enable');
		console.log('[capture] Waiting for first paint...');
		await cdp.awaitRendered(PAINT_TIMEOUT_MS);
		// Past the splash, give the fleet and the transcript a beat to fill in.
		await sleep(2500);

		for (const shot of shots) {
			const file = path.join(outDir, `${shot.name}.${theme}.png`);
			try {
				if (shot.surface) {
					const res = await bridge.send(
						{ type: 'open_modal', surface: shot.surface, tab: shot.tab },
						'open_modal_result'
					);
					// The handler answers with success:false for a surface behind a
					// disabled Encore Feature. Shooting anyway would file the screen
					// BEHIND the modal under the modal's name, which is worse than a gap.
					if (res && res.success === false) {
						throw new Error(res.error || `refused: ${shot.surface}`);
					}
				} else {
					await cdp.escape();
				}
				await sleep(shot.settleMs || SETTLE_MS);
				await cdp.screenshot(file);
				console.log(`[capture]   ${path.basename(file)}`);
			} catch (e) {
				failures.push({ shot: shot.name, error: e.message });
				console.error(`[capture]   SKIPPED ${shot.name}: ${e.message}`);
			}
		}
	} finally {
		bridge && bridge.close();
		cdp && cdp.close();
		if (!keepRunning) killApp(app);
	}
	return failures;
}

async function main() {
	fs.mkdirSync(outDir, { recursive: true });
	console.log(`[capture] Themes:  ${themes.join(', ')}`);
	console.log(`[capture] Shots:   ${shots.length}`);
	console.log(`[capture] Size:    ${size}`);
	console.log(`[capture] Out:     ${outDir}`);

	const allFailures = [];
	for (const theme of themes) {
		console.log(`\n[capture] === ${theme} ===`);
		try {
			const failures = await captureTheme(theme);
			allFailures.push(...failures.map((f) => ({ ...f, theme })));
		} catch (e) {
			// A theme that never came up must not cost the themes after it. Each
			// launch is independent, so record the whole theme as failed and keep
			// going rather than throwing away a run that is most of the way done.
			console.error(`[capture] ${theme} FAILED to start: ${e.message}`);
			allFailures.push(...shots.map((s) => ({ theme, shot: s.name, error: e.message })));
		}
		// Electron does not release the CDP port the instant it is signalled, and
		// the next launch would attach to the dying instance's page.
		if (!keepRunning) await sleep(8000);
	}

	const expected = themes.length * shots.length;
	console.log(`\n[capture] Captured ${expected - allFailures.length} of ${expected}.`);
	if (allFailures.length) {
		console.log('[capture] Skipped:');
		for (const f of allFailures) console.log(`  ${f.theme}/${f.shot}: ${f.error}`);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(`[capture] FAILED: ${e.message}`);
	process.exit(1);
});
