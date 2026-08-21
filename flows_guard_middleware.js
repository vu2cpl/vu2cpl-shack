/**
 * flows_guard_middleware.js — server-side deploy rejection for stale-tab wipes.
 *
 * The pre-commit hook and cron tripwire (flows_guard.py) detect a wiped
 * flows.json AFTER it lands. This middleware stops it from landing at all:
 * wired into Node-RED's settings.js as
 *
 *     httpAdminMiddleware: (() => { try {
 *         return require('/home/vu2cpl/.node-red/projects/vu2cpl-shack/flows_guard_middleware.js');
 *     } catch (e) {
 *         console.log('flows_guard middleware NOT loaded: ' + e.message);
 *         return function (req, res, next) { next(); };
 *     } })(),
 *
 * it inspects every editor Deploy (POST /flows) and rejects — HTTP 400,
 * shown as a red error toast in the editor — any flow config that fails
 * the same structural invariants flows_guard.py checks. The runtime keeps
 * running the healthy flows; nothing is written. This closes the failure
 * mode no client-side hygiene can: ANY browser/device still holding a
 * wiped model (stale tab, conflict-dialog merge, forgotten iPad) simply
 * cannot deploy it.
 *
 * Keep the invariants in sync with flows_guard.py. If a deliberate
 * refactor changes them (e.g. retiring the Vue dashboard), update BOTH
 * files first, then restart Node-RED before deploying the refactor.
 *
 * Note: Node-RED always POSTs the COMPLETE flow config regardless of the
 * deploy type (full/modified-flows/modified-nodes), so the guard sees
 * everything. A "reload"-type POST carries no flows array and passes
 * through untouched, as does every other admin route.
 */

'use strict';

const UIB_NODE_ID = 'uib_shack_01';   // the uibuilder node all Vue builders feed
const MIN_UIB_FEEDERS = 10;           // healthy = 14 (2026-08); wipe = 0
const MIN_NODE_COUNT = 300;           // healthy = 518 (2026-08); catches truncation

function checkFlows(flows) {
    const fails = [];
    if (!Array.isArray(flows)) return ['flows payload is not an array'];
    if (flows.length < MIN_NODE_COUNT) {
        fails.push(`node count ${flows.length} < ${MIN_NODE_COUNT}`);
    }
    const nodes = flows.filter(n => n && typeof n === 'object' && n.id);
    const byid = new Map(nodes.map(n => [n.id, n]));
    const wiresTo = (n, target) => Array.isArray(n.wires) &&
        n.wires.some(out => Array.isArray(out) && out.includes(target));

    // feeders = nodes wired into the uibuilder node directly, plus
    // link-out nodes linked to a link-in that wires into it
    const linkInsToUib = new Set(nodes
        .filter(n => n.type === 'link in' && wiresTo(n, UIB_NODE_ID))
        .map(n => n.id));
    let feeders = 0;
    for (const n of nodes) {
        if (wiresTo(n, UIB_NODE_ID) ||
            (n.type === 'link out' && Array.isArray(n.links) &&
             n.links.some(l => linkInsToUib.has(l)))) {
            feeders++;
        }
    }
    if (feeders < MIN_UIB_FEEDERS) {
        fails.push(`only ${feeders} nodes feed ${UIB_NODE_ID} ` +
                   `(need >= ${MIN_UIB_FEEDERS}) — Vue-bridge wiring wiped?`);
    }

    // zero cross-tab / dead wires (editor-illegal; use link in/out pairs)
    const bad = [];
    for (const n of nodes) {
        if (!n.z || !Array.isArray(n.wires)) continue;
        for (const out of n.wires) {
            if (!Array.isArray(out)) continue;
            for (const t of out) {
                const tn = byid.get(t);
                if (!tn) bad.push(`${n.name || n.id} → ${t} (missing node)`);
                else if (tn.z !== n.z) bad.push(`${n.name || n.id} → ${tn.name || t} (cross-tab)`);
            }
        }
    }
    if (bad.length) {
        const shown = bad.slice(0, 3).join('; ') +
            (bad.length > 3 ? `; … +${bad.length - 3} more` : '');
        fails.push(`${bad.length} cross-tab/dead wire(s) — editor-illegal, ` +
                   `use link in/out pairs: ${shown}`);
    }
    return fails;
}

console.log('flows_guard middleware active (deploy-time flows.json validation)');

module.exports = function flowsGuardMiddleware(req, res, next) {
    if (req.method !== 'POST' || req.path !== '/flows') { next(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        let body = null;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
            res.status(400).json({ message: 'flows_guard: POST /flows body is not valid JSON' });
            return;
        }
        // Deploy API v2 posts {flows:[...], rev}, v1 posts a bare array.
        const flows = Array.isArray(body) ? body : (body && body.flows);
        if (Array.isArray(flows)) {
            const fails = checkFlows(flows);
            if (fails.length) {
                console.log('flows_guard REJECTED a deploy: ' + fails.join('; '));
                res.status(400).json({
                    message: 'flows_guard REJECTED this deploy — the flow config fails ' +
                             'structural invariants. If wiring looks missing, close this ' +
                             'editor tab and open a fresh one; if you just wired across two ' +
                             'flow tabs, use link in / link out nodes instead. Details: ' +
                             fails.join('; ')
                });
                return;
            }
            console.log(`flows_guard: deploy accepted (${flows.length} nodes)`);
        }
        // Hand the already-read body to the admin API's body-parser
        // (body-parser honors req._body and skips re-reading the stream).
        req.body = body;
        req._body = true;
        next();
    });
};
