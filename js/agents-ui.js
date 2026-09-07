// ===================================================================
// AGENTS UI — Settings > Agents pane
// Friendly copy-paste setup for external agents (Claude Code, Codex…)
// Token lifecycle is backend-agnostic (adapter interface). The agent
// connection method is being reworked after the Supabase removal —
// tokens are issued and revocable now; connection instructions follow.
// ===================================================================
import db from './db.js';
import { t } from './i18n.js';
import { esc, showToast, showConfirmAction } from './utils.js';
import { lucideIcon, brandFileIcon } from './icons.js';

let _lastCreatedToken = null;
let _lastCreatedPrompt = null;

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch { return s||''; } }

function buildAgentPrompt({ displayName, token }) {
  return `You have been granted access to my DeLaClaw personal database.

Agent: ${displayName}
DeLaClaw Agent Token: ${token}

Connecting (for you, the AI agent):
DeLaClaw no longer uses Supabase — the agent connection method is being
reworked. Keep this token somewhere safe: a DeLaClaw update will add the
exact connection instructions for the active backend here.

Security: keep this token secret. Never log it, paste it publicly, or
commit it to a repo. It can be revoked anytime from DeLaClaw Settings → Agents.`;
}

async function fetchGrants() {
  try {
    const { data, error } = await db.from('agent_grants').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data||[];
  } catch (e) {
    try { const { data } = await db.from('agent_grants').select('*'); if (data) return data.sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)); } catch {}
    return [];
  }
}

export async function renderAgentsPane() {
  const container = document.getElementById('agentsPaneContent');
  if (!container) return;
  if (localStorage.getItem('claw_cc_active_mode')==='demo') {
    container.innerHTML = `<div class="page-empty-state"><div class="page-empty-icon">${lucideIcon('bot',28)}</div><h3>${esc(t('agents.no_tokens'))}</h3><p class="setting-hint">${esc(t('agents.demo_not_supported'))}</p></div>`;
    return;
  }
  let grants = await fetchGrants();
  const activeGrants = grants.filter(g=>!g.revoked_at);
  const revokedGrants = grants.filter(g=>g.revoked_at);

  const tokenBlock = _lastCreatedToken ? `
    <div class="sharing-group-card agents-token-card">
      <div class="agents-token-card-head">
        <span class="agents-token-card-check">${lucideIcon('check-circle',18)}</span>
        <strong class="agents-token-card-title">${esc(t('agents.token_created_for', { name: _lastCreatedToken.display_name }))}</strong>
      </div>
      <p class="setting-hint agents-copy-hint">${esc(t('agents.copy_prompt_hint'))}</p>
      <textarea id="agentsPrompt" class="agents-prompt-textarea" readonly>${esc(_lastCreatedPrompt||'')}</textarea>
      <div class="agents-actions-row">
        <button class="settings-data-btn primary agents-copy-setup-btn" data-action="agents-copy-prompt">${lucideIcon('copy',14)} ${esc(t('agents.copy_setup'))}</button>
        <button class="settings-data-btn" data-action="agents-copy-last-token">${lucideIcon('key',14)} ${esc(t('agents.copy_token_only'))}</button>
      </div>
      <p class="setting-hint agents-copy-once">${esc(t('agents.token_copy_once'))}</p>
    </div>` : '';

  const createRow = `
    <div class="setting-group agents-create-card${_lastCreatedToken?' agents-create-card-offset':''}">
      <div class="agents-create-head">
        <span class="agents-create-icon">${lucideIcon('bot',18)}</span>
        <div class="agents-create-body">
          <div class="setting-group-label agents-create-label">${esc(t('agents.create_title'))}</div>
          <p class="setting-hint agents-create-hint">${esc(t('agents.create_hint_friendly'))}</p>
        </div>
      </div>
      <div class="sharing-invite-row agents-name-row">
        <input type="text" class="sharing-invite-input agents-name-input" id="agentsNewName" placeholder="${esc(t('agents.name_placeholder'))}" maxlength="80">
        <button class="sharing-invite-btn agents-create-btn" data-action="agents-create" id="agentsCreateBtn">${lucideIcon('plus',14)} ${esc(t('agents.create_btn'))}</button>
      </div>
      <div class="agents-pill-row">
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Claude Code">${brandFileIcon('claude',12)} Claude Code</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Codex CLI">${brandFileIcon('codex',12)} Codex CLI</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="OpenClaw">${brandFileIcon('openclaw',12)} OpenClaw</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Hermes">${brandFileIcon('hermes',12)} Hermes</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="NanoClaw">${brandFileIcon('nanoclaw',12)} NanoClaw</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Grok Bot">${brandFileIcon('grok',12)} Grok Bot</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Cursor">${brandFileIcon('cursor',12)} Cursor</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Aider">${lucideIcon('git-branch',12)} Aider</span>
      </div>
    </div>`;

  let listHtml = '';
  if (!grants.length && !_lastCreatedToken) {
    listHtml = `<div class="page-empty-state agents-empty"><div class="page-empty-icon">${lucideIcon('shield',28)}</div><h3>${esc(t('agents.no_tokens'))}</h3><p>${esc(t('agents.no_tokens_hint_friendly'))}</p></div>`;
  } else if (grants.length) {
    const rowFor = (g) => {
      const revoked = !!g.revoked_at;
      const lastUsed = g.last_used_at ? `${esc(t('agents.last_used'))}: ${esc(fmtDate(g.last_used_at))}` : esc(t('agents.never_used'));
      const created = g.created_at ? esc(fmtDate(g.created_at)) : '';
      return `<div class="sharing-group-card${revoked?' agents-grant-revoked':''}">
        <div class="sharing-group-header">
          <div class="sharing-group-info">
            <h4 class="agents-grant-title">${esc(g.display_name)} ${revoked?`<span class="agents-grant-status agents-grant-status-revoked">· ${esc(t('agents.revoked_label'))}</span>`:`<span class="agents-grant-status agents-grant-status-active">· ${esc(t('agents.active_label'))}</span>`}</h4>
            <span class="sharing-group-stats">${created} · ${lastUsed}</span>
          </div>
          <div class="sharing-group-actions">${!revoked?`<button class="sharing-action-btn sharing-leave-btn" data-action="agents-revoke" data-id="${esc(g.id)}">${lucideIcon('trash-2',14)} ${esc(t('agents.revoke'))}</button>`:''}</div>
        </div>
      </div>`;
    };
    listHtml = `<div class="setting-group agents-list"><div class="setting-group-label agents-list-head"><span>${esc(t('agents.manage_title'))} (${activeGrants.length})</span><span class="agents-revoke-hint">${esc(t('agents.revoke_hint'))}</span></div>`;
    for (const g of activeGrants) listHtml += rowFor(g);
    if (revokedGrants.length) { listHtml+=`<div class="setting-group-label agents-revoked-section">${esc(t('agents.revoked'))} (${revokedGrants.length})</div>`; for (const g of revokedGrants) listHtml+=rowFor(g); }
    listHtml+=`</div>`;
  }

  const explainer = `
    <div class="setting-group agents-explainer">
      <div class="setting-group-label agents-explainer-label">${lucideIcon('info',14)} ${esc(t('agents.how_it_works'))}</div>
      <p class="setting-hint agents-explainer-body">${esc(t('agents.how_it_works_body'))}</p>
    </div>`;

  container.innerHTML = `<p class="setting-hint agents-description">${esc(t('agents.description_friendly'))}</p>${tokenBlock}${createRow}${listHtml}${explainer}`;

  const input = document.getElementById('agentsNewName');
  if (input) { input.addEventListener('keydown', (e)=>{ if (e.key==='Enter') agentsCreate(); }); setTimeout(()=>input.focus(),40); }
}

async function agentsCreate() {
  const input = document.getElementById('agentsNewName');
  const btn = document.getElementById('agentsCreateBtn');
  const name = input?.value?.trim();
  if (!name) { showToast(t('agents.name_required'),'error'); return; }
  if (btn) { btn.disabled=true; btn.classList.add('is-pending'); }
  try {
    const rawBytes=new Uint8Array(32); crypto.getRandomValues(rawBytes);
    const raw=Array.from(rawBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
    const hash=await sha256Hex(raw);
    const rec={ display_name:name, token_hash:hash, scope:'full' };
    const { data, error:insErr } = await db.from('agent_grants').insert(rec).select();
    if (insErr) throw insErr;
    const inserted = Array.isArray(data)?data[0]:data;
    const result={ id:inserted?.id||null, token:raw, display_name:name, scope:'full', created_at:new Date().toISOString() };
    _lastCreatedToken=result;
    _lastCreatedPrompt=buildAgentPrompt({ displayName:name, token:result.token });
    if (input) input.value='';
    showToast(t('agents.token_created'),'success');
    await renderAgentsPane();
    setTimeout(()=>document.getElementById('agentsPrompt')?.select(),120);
  } catch (e) { console.warn(e); showToast(e.message||'Failed','error'); }
  finally { if (btn){ btn.disabled=false; btn.classList.remove('is-pending'); } }
}

function agentsRevoke(id) {
  showConfirmAction(t('agents.revoke'), t('agents.revoke_confirm'), async ()=>{
    try {
      const { error } = await db.from('agent_grants').update({ revoked_at:new Date().toISOString() }).eq('id',id);
      if (error) throw error;
      if (_lastCreatedToken && _lastCreatedToken.id===id){ _lastCreatedToken=null; _lastCreatedPrompt=null; }
      showToast(t('agents.revoked'),'info');
      await renderAgentsPane();
    } catch (e){ showToast(e.message,'error'); }
  });
}
function agentsCopyLastToken() {
  if (!_lastCreatedToken) return;
  navigator.clipboard.writeText(_lastCreatedToken.token).then(()=>showToast(t('agents.copied_token'),'success')).catch(()=>{
    const el=document.getElementById('agentsPrompt'); if(el){ el.select(); document.execCommand('copy'); showToast(t('agents.copied_token'),'success'); }
  });
}
function agentsCopyPrompt() {
  if (!_lastCreatedPrompt) return;
  navigator.clipboard.writeText(_lastCreatedPrompt).then(()=>showToast(t('agents.copied_setup'),'success')).catch(()=>{
    const el=document.getElementById('agentsPrompt'); if(el){ el.select(); document.execCommand('copy'); showToast(t('agents.copied_setup'),'success'); }
  });
}
export function applyAgentsI18n() {
  const titleEl=document.getElementById('settingsPaneAgentsTitle'); if(titleEl) titleEl.textContent=t('agents.title');
  const navEl=document.getElementById('settingsNavAgents'); if(navEl) navEl.textContent=t('agents.nav');
}
function agentsPrefillName(el) {
  const name = el?.dataset?.name;
  const input = document.getElementById('agentsNewName');
  if (!name || !input) return;
  input.value = name;
  input.focus();
}
window.agentsPrefillName=agentsPrefillName;
window.agentsCreate=agentsCreate;
window.agentsRevoke=agentsRevoke;
window.agentsCopyLastToken=agentsCopyLastToken;
window.agentsCopyPrompt=agentsCopyPrompt;
