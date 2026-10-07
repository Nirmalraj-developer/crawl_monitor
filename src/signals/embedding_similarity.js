/**
 * Signal 2: Embedding Semantic Similarity (src/signals/embedding_similarity.js)
 * ----------------------------------------------------------------------------
 * Computes deep semantic meaning similarity between company texts.
 * Uses provider embeddings if API key is present (e.g. OpenAI text-embedding-3-small),
 * or falls back to a deterministic, high-dimensional character n-gram / term projection
 * vector space when operating locally/offline.
 *
 * Produces:
 * - raw similarity score (0.0 to 1.0)
 * - cosine distance
 * - embedding model metadata
 */

function projectToVector(text, dimensions = 128) {
  const vec = new Float64Array(dimensions);
  if (!text || typeof text !== 'string') return vec;

  const normalized = text.toLowerCase().trim().replace(/\s+/g, ' ');
  if (!normalized) return vec;

  // Character trigrams & word tokens for semantic projection
  const tokens = normalized.split(/\s+/);
  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = (hash << 5) - hash + token.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vec[idx] += sign * (1 / Math.sqrt(tokens.length));
  }

  // 3-grams
  for (let i = 0; i <= normalized.length - 3; i++) {
    const gram = normalized.slice(i, i + 3);
    let hash = 5381;
    for (let j = 0; j < gram.length; j++) {
      hash = ((hash << 5) + hash) + gram.charCodeAt(j);
      hash |= 0;
    }
    const idx = Math.abs(hash) % dimensions;
    vec[idx] += 0.5;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }
  // Clamp between 0.0 and 1.0
  return Math.max(0.0, Math.min(1.0, (dot + 1) / 2));
}

async function computeEmbeddingSimilarity(oldText, newText, options = {}) {
  const textA = oldText !== null && oldText !== undefined ? String(oldText).trim() : '';
  const textB = newText !== null && newText !== undefined ? String(newText).trim() : '';

  if (!textA && !textB) {
    return {
      signal: 'embedding_semantic_similarity',
      similarity: 1.0,
      cosineDistance: 0.0,
      model: 'identical_empty',
      isExactMatch: true
    };
  }

  if (!textA || !textB) {
    return {
      signal: 'embedding_semantic_similarity',
      similarity: 0.0,
      cosineDistance: 1.0,
      model: 'missing_counterpart',
      isExactMatch: false
    };
  }

  if (textA === textB) {
    return {
      signal: 'embedding_semantic_similarity',
      similarity: 1.0,
      cosineDistance: 0.0,
      model: 'exact_string',
      isExactMatch: true
    };
  }

  // If OpenAI API key is supplied and enabled
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && options.useExternalEmbeddings) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: [textA.slice(0, 1000), textB.slice(0, 1000)]
        })
      });
      if (response.ok) {
        const data = await response.json();
        const vA = data.data[0].embedding;
        const vB = data.data[1].embedding;
        let dot = 0;
        for (let i = 0; i < vA.length; i++) dot += vA[i] * vB[i];
        const sim = Math.max(0.0, Math.min(1.0, dot));
        return {
          signal: 'embedding_semantic_similarity',
          similarity: parseFloat(sim.toFixed(4)),
          cosineDistance: parseFloat((1.0 - sim).toFixed(4)),
          model: 'openai/text-embedding-3-small',
          isExactMatch: false
        };
      }
    } catch {
      // Fall through to deterministic vector projection
    }
  }

  // Deterministic local projection
  const vecA = projectToVector(textA);
  const vecB = projectToVector(textB);
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
  }
  const sim = Math.max(0.0, Math.min(1.0, dotProduct));

  return {
    signal: 'embedding_semantic_similarity',
    similarity: parseFloat(sim.toFixed(4)),
    cosineDistance: parseFloat((1.0 - sim).toFixed(4)),
    model: 'local_semantic_projection_128d',
    isExactMatch: false
  };
}

module.exports = {
  computeEmbeddingSimilarity,
  projectToVector,
  cosineSimilarity
};

