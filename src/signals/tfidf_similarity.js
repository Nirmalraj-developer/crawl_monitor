/**
 * Signal 3: TF-IDF + Cosine Similarity (src/signals/tfidf_similarity.js)
 * ----------------------------------------------------------------------
 * Measures term-frequency inverse document frequency weighted similarity.
 * Emphasizes rare distinctive keywords (e.g. brand, sector names) over common stop words.
 *
 * Produces:
 * - cosine similarity (0.0 to 1.0)
 * - top shared distinctive terms
 * - top shifted terms (added/removed)
 */

// Pure grammatical stop words (strictly excludes negations like 'not', 'no', 'never'
// and business action terms to preserve polarity and material change signals)
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but',
  'in', 'on', 'at', 'to', 'for', 'from', 'with', 'by', 'of', 'into', 'across', 'over',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'that', 'this', 'these', 'those', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where', 'how',
  'it', 'its', 'he', 'she', 'they', 'them', 'their', 'we', 'our', 'you', 'your'
]);

function tokenizeWords(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function computeTermFrequencies(tokens) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  const total = tokens.length || 1;
  for (const t in tf) {
    tf[t] = tf[t] / total;
  }
  return tf;
}

function computeTfidfCosineSimilarity(oldText, newText) {
  const textA = oldText !== null && oldText !== undefined ? String(oldText).trim() : '';
  const textB = newText !== null && newText !== undefined ? String(newText).trim() : '';

  if (!textA && !textB) {
    return {
      signal: 'tfidf_cosine_similarity',
      similarity: 1.0,
      sharedTerms: [],
      addedTerms: [],
      removedTerms: []
    };
  }

  if (!textA || !textB) {
    return {
      signal: 'tfidf_cosine_similarity',
      similarity: 0.0,
      sharedTerms: [],
      addedTerms: tokenizeWords(textB),
      removedTerms: tokenizeWords(textA)
    };
  }

  const tokensA = tokenizeWords(textA);
  const tokensB = tokenizeWords(textB);

  if (tokensA.length === 0 && tokensB.length === 0) {
    return {
      signal: 'tfidf_cosine_similarity',
      similarity: 1.0,
      sharedTerms: [],
      addedTerms: [],
      removedTerms: []
    };
  }

  const tfA = computeTermFrequencies(tokensA);
  const tfB = computeTermFrequencies(tokensB);

  const allVocab = Array.from(new Set([...Object.keys(tfA), ...Object.keys(tfB)]));

  // Compute IDF over this pair corpus (smooth IDF)
  const idf = {};
  for (const term of allVocab) {
    let docCount = 0;
    if (tfA[term]) docCount++;
    if (tfB[term]) docCount++;
    // log(1 + (N / docCount))
    idf[term] = Math.log(1 + (2 / docCount));
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  const sharedTerms = [];
  const addedTerms = [];
  const removedTerms = [];

  for (const term of allVocab) {
    const valA = (tfA[term] || 0) * idf[term];
    const valB = (tfB[term] || 0) * idf[term];

    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;

    if (valA > 0 && valB > 0) {
      sharedTerms.push(term);
    } else if (valA > 0 && valB === 0) {
      removedTerms.push(term);
    } else if (valA === 0 && valB > 0) {
      addedTerms.push(term);
    }
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  const similarity = denominator === 0 ? 0.0 : dotProduct / denominator;

  return {
    signal: 'tfidf_cosine_similarity',
    similarity: parseFloat(Math.min(1.0, Math.max(0.0, similarity)).toFixed(4)),
    sharedTerms: sharedTerms.slice(0, 10),
    addedTerms: addedTerms.slice(0, 10),
    removedTerms: removedTerms.slice(0, 10)
  };
}

module.exports = {
  computeTfidfCosineSimilarity,
  tokenizeWords,
  computeTermFrequencies
};

