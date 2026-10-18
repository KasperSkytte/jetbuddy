import { html, useState } from '../lib.js';
import { useStore } from '../store.js';
import { t } from '../i18n.js';
import { Sheet, Segmented, Icon } from '../ui.js';

/** Download the budget as an Excel workbook, e.g. for the bank. */
export function ExportSheet({ onClose }) {
  const { household, year: current } = useStore();
  const years = [...new Set([...household.years, current])].sort((a, b) => b - a);
  const [year, setYear] = useState(current);
  const [group, setGroup] = useState('auto');
  return html`<${Sheet} title=${t('export.title')} onClose=${onClose}
    footer=${html`<span class="spacer"></span><button class="btn" onClick=${onClose}>${t('common.close')}</button>
      <a class="btn primary" href=${`/api/export/${year}.xlsx?group=${group}`} download onClick=${() => setTimeout(onClose, 300)}>
        <${Icon} name="download" size=${18} />${t('export.download')}</a>`}>
    <div class="stack">
      <p class="secondary" style="margin:0">${t('export.intro')}</p>
      <ul class="small secondary" style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px">
        <li>${t('export.sheetSummary')}</li><li>${t('export.sheetBudget')}</li>
        <li>${t('export.sheetActual')}</li><li>${t('export.sheetBalances')}</li>
      </ul>
      <label class="field"><span>${t('export.year')}</span>
        <select class="input" value=${year} onChange=${(e) => setYear(Number(e.target.value))}>
          ${years.map((y) => html`<option key=${y} value=${y}>${y}</option>`)}</select></label>
      <div class="field"><span>${t('export.groupBy')}</span>
        <${Segmented} value=${group} onChange=${setGroup}
          options=${[{ value: 'auto', label: t('export.auto') }, { value: 'category', label: t('export.category') }, { value: 'member', label: t('export.member') }]} />
        <span class="hint">${t('export.groupHint')}</span></div>
    </div>
  </${Sheet}>`;
}
