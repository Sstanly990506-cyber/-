import { $ } from './shared.js';
import { parseSizeNotation } from './pricing.js';

const EMPTY_HINT = '輸入尺寸後會換算成台吋；K 數與菊版請先在設定的報價公式中填入對應天×地。';

export function applySizeNotation(state, onResolved = () => {}) {
  const input = $('sizeNotation');
  const hint = $('sizeNotationHint');
  if (!input) return false;
  const result = parseSizeNotation(input.value, state.settings?.moduleInternals?.orders?.pricingRules?.sizePresets);
  if (result.empty) {
    if (hint) hint.textContent = EMPTY_HINT;
    return false;
  }
  if (!result.matched) {
    if (hint) hint.textContent = `尚未設定「${input.value.trim()}」的天×地台吋。請到設定 > 工單作業系統 > 報價公式新增對照。`;
    return false;
  }
  $('sizeLength').value = result.length.toFixed(2).replace(/\.00$/, '');
  $('sizeWidth').value = result.width.toFixed(2).replace(/\.00$/, '');
  $('sizeUnit').value = 'tai-inch';
  if (hint) hint.textContent = `${result.label} 已換算為：天 ${result.length.toFixed(2)} × 地 ${result.width.toFixed(2)} 台吋。`;
  onResolved();
  return true;
}
