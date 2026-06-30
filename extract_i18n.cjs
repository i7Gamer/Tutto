const fs = require('fs');
const path = require('path');

function walkSync(currentDirPath, callback) {
    fs.readdirSync(currentDirPath).forEach(function (name) {
        var filePath = path.join(currentDirPath, name);
        var stat = fs.statSync(filePath);
        if (stat.isFile()) {
            callback(filePath, stat);
        } else if (stat.isDirectory()) {
            walkSync(filePath, callback);
        }
    });
}

const keys = {};

walkSync('./src', (filePath) => {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) {
        const content = fs.readFileSync(filePath, 'utf8');
        // Matches t('key', 'default') or t("key", "default")
        // Also supports t('key', "default") etc.
        const regex = /t\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            keys[match[1]] = match[2];
        }
    }
});

fs.writeFileSync('./src/locales/en/translation.json', JSON.stringify(keys, null, 2));
console.log('Extracted ' + Object.keys(keys).length + ' keys.');
