export const COMPANY_INFO = {
  name: '三青實業有限公司',
  address: 'No. 53, Liyan St, Zhonghe District, New Taipei City, Taiwan 235',
};

export const $ = (id) => document.getElementById(id);

export function money(n) {
  return Number(n || 0).toLocaleString();
}

export function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
    .join('\n');
}

export function downloadCsv(filename, rows) {
  const blob = new Blob(['\ufeff' + toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function formatTs(ts) {
  if (!ts) return '尚未同步';
  return new Date(ts).toLocaleTimeString();
}

export function getTodayText() {
  return new Date().toISOString().slice(0, 10);
}
