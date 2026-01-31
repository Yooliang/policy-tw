const XLSX = require('xlsx');
const fs = require('fs');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node parse-election-results.cjs <excel-file>');
  process.exit(1);
}

// Parse ROC date to ISO date string
function parseROCDate(rocDate) {
  if (!rocDate || typeof rocDate !== 'string') return null;
  const match = rocDate.match(/(\d{2,3})\/(\d{2})\/(\d{2})/);
  if (!match) return null;
  const year = parseInt(match[1]) + 1911;
  const month = match[2];
  const day = match[3];
  return `${year}-${month}-${day}`;
}

// Extract birth year from ROC date
function extractBirthYear(rocDate) {
  if (!rocDate || typeof rocDate !== 'string') return null;
  const match = rocDate.match(/(\d{2,3})\//);
  if (!match) return null;
  return parseInt(match[1]) + 1911;
}

// Parse vote count (remove commas)
function parseVotes(votes) {
  if (!votes) return 0;
  return parseInt(String(votes).replace(/,/g, '')) || 0;
}

try {
  const workbook = XLSX.readFile(filePath);
  const results = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    // Find header row (contains "候選人姓名")
    let headerRowIndex = -1;
    for (let i = 0; i < Math.min(10, data.length); i++) {
      if (data[i] && data[i].some(cell => String(cell).includes('候選人姓名'))) {
        headerRowIndex = i;
        break;
      }
    }

    if (headerRowIndex === -1) {
      console.error(`No header found in sheet: ${sheetName}`);
      continue;
    }

    const headers = data[headerRowIndex];
    const nameCol = headers.findIndex(h => String(h).includes('候選人姓名'));
    const genderCol = headers.findIndex(h => String(h).includes('性別'));
    const birthCol = headers.findIndex(h => String(h).includes('出生'));
    const partyCol = headers.findIndex(h => String(h).includes('政黨'));
    const votesCol = headers.findIndex(h => String(h).includes('得票'));
    const electedCol = headers.findIndex(h => String(h).includes('當選'));

    // Process data rows
    for (let i = headerRowIndex + 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[nameCol]) continue;

      const name = String(row[nameCol]).trim();
      if (!name || name === '') continue;

      results.push({
        region: sheetName,
        name: name,
        gender: row[genderCol] || null,
        birthDate: parseROCDate(row[birthCol]),
        birthYear: extractBirthYear(row[birthCol]),
        party: row[partyCol] || '無',
        votes: parseVotes(row[votesCol]),
        elected: row[electedCol] === '是',
      });
    }
  }

  // Output JSON
  console.log(JSON.stringify(results, null, 2));

} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
