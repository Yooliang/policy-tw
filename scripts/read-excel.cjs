const XLSX = require('xlsx');
const path = require('path');

const filePath = process.argv[2] || 'C:/Users/cwen0708/Downloads/縣表11-1-00(中央)-111年直轄市、縣(市)長選舉結果清冊.xls';

try {
  const workbook = XLSX.readFile(filePath);
  console.log('Sheets:', workbook.SheetNames);

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  console.log('\n--- First 40 rows ---\n');
  data.slice(0, 40).forEach((row, i) => {
    console.log(i, JSON.stringify(row));
  });
} catch (err) {
  console.error('Error:', err.message);
}
