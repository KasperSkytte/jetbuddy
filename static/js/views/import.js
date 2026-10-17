import { html, useState } from '../lib.js';
import { request } from '../api.js';
import { useStore, bump, setStore, reloadHousehold } from '../store.js';
import { t } from '../i18n.js';
import { money, sum } from '../fmt.js';
import { Sheet, Segmented, Switch, Icon, toast, toastError } from '../ui.js';
import { members } from '../model.js';

const SHARED_WORDS = /shared|household|joint|common|f(æ|ae)lles|felles|gemensam|gemeinsam|family|familie/i;

/** Guess whose sheet "A ud" or "Alex expenses" is from its name. */
function guessMember(name, people) {
  const lower = name.toLowerCase();
  const shared = people.find((m) => m.is_shared);
  const full = people.filter((m) => lower.includes(m.name.toLowerCase()));
  if (full.length === 1) return full[0].id;
  if (SHARED_WORDS.test(lower) && shared) return shared.id;
  const token = lower.split(/[\s_\-.]+/)[0];
  if (token) {
    const byInitial = people.filter((m) => m.name.toLowerCase().startsWith(token));
    if (byInitial.length === 1) return byInitial[0].id;
  }
  return null;
}

export function ImportSheet({ onClose }) {
  const { household, year: currentYear } = useStore();
  const people = members(household);
  const [year, setYear] = useState(currentYear);
  const [sheets, setSheets] = useState(null);
  const [skipEmpty, setSkipEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);

  const pick = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const y = file.name.match(/(?:19|20)\d{2}/);
    if (y) setYear(Number(y[0]));
    const body = new FormData();
    body.append('file', file);
    setBusy(true);
    try {
      const r = await request('POST', '/api/import/preview', body);
      if (!r.sheets.length) toast(t('import.nothingFound'), { error: true });
      setSheets(r.sheets.map((s) => ({
        ...s,
        include: !s.looks_like_summary,
        member_id: guessMember(s.name, people),
        kind: s.kind || 'expense',
      })));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  const update = (i, patch) => setSheets((all) => all.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const chosen = (sheets || []).filter((s) => s.include);
  const ready = chosen.length > 0 && chosen.every((s) => s.member_id) && year >= 1900 && year <= 2200;

  const commit = async () => {
    setBusy(true);
    try {
      const r = await request('POST', '/api/import/commit', {
        year,
        sheets: chosen.map((s) => ({
          member_id: s.member_id,
          kind: s.kind,
          rows: s.rows.filter((row) => !skipEmpty || row.amounts.some((v) => v)),
        })),
      });
      toast(t('import.done', { created: r.created, updated: r.updated, year }));
      await reloadHousehold();
      setStore({ year });
      bump();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return html`<${Sheet} wide title=${t('import.title')} onClose=${onClose}
    footer=${sheets && html`<button class="btn" onClick=${() => setSheets(null)}>${t('common.back')}</button><span class="spacer"></span>
      <button class="btn primary" disabled=${!ready || busy} onClick=${commit}>${t('import.import', { n: chosen.length, year })}</button>`}>
    ${!sheets ? html`<div class="stack">
      <p class="secondary" style="margin:0">${t('import.intro')}</p>
      <pre class="small" style="background:var(--surface-2);padding:10px 12px;border-radius:10px;overflow-x:auto;margin:0">${'          Jan    Feb    Mar  …\nSalary    31250  34600  31250\nRent      12450  12900  12300'}</pre>
      <p class="small muted" style="margin:0">${t('import.introMore')}</p>
      <label class="btn primary" style="align-self:flex-start;cursor:pointer">
        <${Icon} name="upload" size=${18} />${busy ? t('common.loading') : t('import.choose')}
        <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" class="sr-only" onChange=${pick} disabled=${busy} /></label>
    </div>` : html`<div class="stack">
      <div class="row wrap" style="gap:16px">
        <label class="field" style="width:140px"><span>${t('import.year')}</span>
          <input class="input" type="number" inputmode="numeric" value=${year} onInput=${(e) => setYear(Number(e.target.value))} /></label>
        <div class="spacer" style="min-width:220px"><${Switch} checked=${skipEmpty} onChange=${setSkipEmpty} label=${t('import.skipEmpty')} /></div>
      </div>
      <p class="small secondary" style="margin:0">${t('import.mapHint')}</p>
      ${sheets.map((s, i) => {
        const rows = s.rows.filter((row) => !skipEmpty || row.amounts.some((v) => v));
        return html`<div key=${i} class="card" style="padding:12px;opacity:${s.include ? 1 : 0.6}">
          <div class="row wrap">
            <label class="row" style="cursor:pointer;min-height:40px"><input type="checkbox" checked=${s.include} onChange=${(e) => update(i, { include: e.target.checked })} style="width:20px;height:20px" />
              <strong>${s.name}</strong></label>
            <span class="small muted">${t('import.rows', { n: rows.length })}</span>
            ${s.looks_like_summary && html`<span class="badge">${t('import.summary')}</span>`}
            <span class="spacer"></span>
            <button class="btn ghost small" onClick=${() => setOpen(open === i ? null : i)}>${open === i ? t('import.hideRows') : t('import.showRows')}</button>
          </div>
          ${s.include && html`<div class="row wrap" style="margin-top:8px;gap:10px">
            <select class="input" style="width:auto;min-width:160px;flex:1" value=${s.member_id ?? ''} onChange=${(e) => update(i, { member_id: Number(e.target.value) || null })}>
              <option value="">${t('import.whose')}</option>
              ${people.map((m) => html`<option key=${m.id} value=${m.id}>${m.name}</option>`)}
            </select>
            <${Segmented} value=${s.kind} onChange=${(kind) => update(i, { kind })}
              options=${[{ value: 'income', label: t('common.income') }, { value: 'expense', label: t('common.expenses') }]} />
          </div>`}
          ${open === i && html`<div class="list" style="margin-top:8px">${rows.map((row, k) => html`<div key=${k} class="row small" style="padding:4px 0;border-top:1px solid var(--border)">
            <span class="spacer ellipsis">${row.name}</span><span class="num">${money(sum(row.amounts))}</span></div>`)}</div>`}
        </div>`;
      })}
      <p class="small muted" style="margin:0">${t('import.mergeHint')}</p>
    </div>`}
  </${Sheet}>`;
}
