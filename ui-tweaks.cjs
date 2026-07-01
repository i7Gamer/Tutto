const fs = require('fs');

// 1. Update widths
['src/components/Home.tsx', 'src/components/Game.tsx', 'src/components/Statistics.tsx', 'src/components/EndScreen.tsx'].forEach(file => {
  let c = fs.readFileSync(file, 'utf8');
  c = c.replace(/max-w-3xl/g, 'max-w-xl');
  fs.writeFileSync(file, c);
});

// 2. Remove gray backgrounds for cleaner look
const walk = (dir) => {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = dir + '/' + file;
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.tsx')) results.push(file);
    }
  });
  return results;
};

walk('src/components').forEach(file => {
  let c = fs.readFileSync(file, 'utf8');
  c = c.replace(/bg-gray-50\/50/g, 'bg-black/5 dark:bg-white/5');
  c = c.replace(/bg-gray-100\/80/g, 'bg-black/5 dark:bg-white/5');
  c = c.replace(/bg-gray-50\/80/g, 'bg-black/5 dark:bg-white/5');
  c = c.replace(/bg-gray-50(?!0)/g, 'bg-black/5 dark:bg-white/5'); // bg-gray-50 but not bg-gray-500
  c = c.replace(/bg-gray-100(?!0)/g, 'bg-black/5 dark:bg-white/5');
  fs.writeFileSync(file, c);
});

console.log('UI tweaks applied.');
