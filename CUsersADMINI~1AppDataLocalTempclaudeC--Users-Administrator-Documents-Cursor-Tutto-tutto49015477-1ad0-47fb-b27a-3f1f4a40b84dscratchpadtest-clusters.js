import { buildDeck } from './src/utils/coreGameEngine.js';

function analyzeCluster(initialCards) {
  let maxCluster = 1;
  let clusters = [];
  
  const deck = buildDeck(initialCards);
  for (let i = 1; i < deck.length; i++) {
    let cluster = 1;
    while (i < deck.length && deck[i] === deck[i - 1]) {
      cluster++;
      i++;
    }
    if (cluster > 1) clusters.push(cluster);
    maxCluster = Math.max(maxCluster, cluster);
  }
  
  return { maxCluster, clusters };
}

// Test standard deck
const standard = {
  '200': 5, '300': 5, '400': 5, '500': 5, '600': 5,
  'Kniffel': 10, 'Plus_Minus': 5, 'x2': 5,
  'Feuerwerk': 5, 'Kleeblatt': 5, 'Stop': 5
};

// Test high-frequency
const highFreq = { 'Kniffel': 10, '200': 5 };

console.log('Standard deck (10 runs):');
for (let i = 0; i < 10; i++) {
  const { maxCluster, clusters } = analyzeCluster(standard);
  console.log(`  Run ${i + 1}: max=${maxCluster}, clusters=${JSON.stringify(clusters)}`);
}

console.log('\nHigh-frequency (10 runs):');
for (let i = 0; i < 10; i++) {
  const { maxCluster, clusters } = analyzeCluster(highFreq);
  console.log(`  Run ${i + 1}: max=${maxCluster}, clusters=${JSON.stringify(clusters)}`);
}
