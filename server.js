require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_SECRET_KEY
});

// Helper function to fetch URL with proxy fallback
async function fetchWithProxy(url, options = {}) {
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache'
  };

  // Try direct fetch first
  try {
    console.log('Trying direct fetch...');
    const response = await axios.get(url, {
      headers: { ...defaultHeaders, ...options.headers },
      timeout: 15000
    });
    return response.data;
  } catch (directError) {
    console.log(`Direct fetch failed: ${directError.message}`);
    
    // If 403, try with Jina Reader (renders JavaScript!)
    if (directError.response?.status === 403 || directError.response?.status === 401) {
      // Try Jina Reader first - it renders JS and returns clean text
      try {
        const jinaUrl = `https://r.jina.ai/${url}`;
        console.log('Trying Jina Reader (renders JS)...');
        const response = await axios.get(jinaUrl, {
          headers: {
            'Accept': 'text/plain',
            'X-Return-Format': 'text'
          },
          timeout: 30000
        });
        console.log('Jina Reader successful');
        // Jina returns markdown/text, wrap it for our parser
        return `<body>${response.data}</body>`;
      } catch (jinaError) {
        console.log(`Jina Reader failed: ${jinaError.message}`);
      }
      
      // Fallback to CORS proxies
      const proxies = [
        (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
        (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`
      ];
      
      for (const proxyFn of proxies) {
        const proxyUrl = proxyFn(url);
        try {
          console.log(`Trying proxy: ${proxyUrl.substring(0, 50)}...`);
          const response = await axios.get(proxyUrl, {
            headers: {
              'User-Agent': defaultHeaders['User-Agent']
            },
            timeout: 20000
          });
          console.log('Proxy fetch successful');
          return response.data;
        } catch (proxyError) {
          console.log(`Proxy failed: ${proxyError.message}`);
          continue;
        }
      }
    }
    
    // Re-throw original error if all proxies failed
    throw directError;
  }
}

// Fetch URL content using ScrapingAnt (renders JavaScript, handles anti-bot)
async function fetchWithScrapingAnt(url) {
  const apiKey = process.env.SCRAPINGANT_API_KEY;
  if (!apiKey) {
    throw new Error('SCRAPINGANT_API_KEY not configured');
  }
  
  // Use browser=true for JavaScript rendering, proxy_country=FR for French IPs
  const apiUrl = `https://api.scrapingant.com/v2/general?url=${encodeURIComponent(url)}&x-api-key=${apiKey}&browser=true&proxy_country=FR`;
  console.log('Fetching with ScrapingAnt (browser mode)...');
  
  const response = await axios.get(apiUrl, { timeout: 120000 });
  console.log(`ScrapingAnt returned ${response.data.length} characters`);
  return response.data;
}

// Fetch URL content using Jina Reader (renders JavaScript)
async function fetchWithJina(url) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  console.log('Fetching with Jina Reader...');
  const response = await axios.get(jinaUrl, {
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'text'
    },
    timeout: 45000
  });
  console.log(`Jina Reader returned ${response.data.length} characters`);
  return response.data;
}

// Smart fetch for SPAs - tries ScrapingAnt first, then Jina
async function fetchRenderedContent(url) {
  // Try ScrapingAnt first (best for anti-bot sites like SeLoger)
  if (process.env.SCRAPINGANT_API_KEY) {
    try {
      const html = await fetchWithScrapingAnt(url);
      if (html && html.length > 500) {
        // Parse HTML and extract text
        const $ = cheerio.load(html);
        $('script').remove();
        $('style').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim();
        if (text.length > 200) {
          return text;
        }
      }
    } catch (e) {
      console.log('ScrapingAnt failed:', e.message);
    }
  }
  
  // Fallback to Jina Reader
  try {
    return await fetchWithJina(url);
  } catch (e) {
    console.log('Jina Reader failed:', e.message);
    throw e;
  }
}

// Fetch and parse property listing
app.post('/api/extract', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Fetching URL: ${url}`);

    // ===== FOR SELOGER: Use ScrapingAnt or Jina Reader =====
    if (url.includes('seloger.com')) {
      try {
        const textContent = await fetchRenderedContent(url);
        
        if (textContent.length > 100) {
          console.log(`Got ${textContent.length} chars, using LLM to extract SeLoger data...`);
          
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `Tu extrais les informations d'une annonce immobilière SeLoger.
Retourne UNIQUEMENT un objet JSON avec ces champs (null si non trouvé, ne jamais inventer):

{
  "prix": number | null,           // Prix de vente en euros
  "chargesCopro": number | null,   // Charges de copropriété mensuelles en euros
  "taxeFonciere": number | null,   // Taxe foncière annuelle en euros
  "nombreChambres": number | null, // Nombre de chambres (pas pièces)
  "surface": number | null,        // Surface en m²
  "titre": string | null,          // Titre de l'annonce
  "ville": string | null,          // Ville
  "codePostal": string | null      // Code postal (5 chiffres)
}

Important:
- Cherche le prix de vente (pas de loyer)
- Les charges sont mensuelles
- Ne confonds pas pièces et chambres`
              },
              {
                role: 'user',
                content: `Annonce SeLoger:\n\n${textContent.substring(0, 10000)}`
              }
            ],
            temperature: 0.1,
            max_tokens: 500
          });
          
          const content = completion.choices[0].message.content;
          console.log('SeLoger LLM response:', content);
          
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            return res.json({ success: true, data });
          }
        }
      } catch (selogerError) {
        console.error('SeLoger extraction error:', selogerError.message);
      }
      // Fall through to generic extraction
    }

    // ===== SPECIAL HANDLING FOR BIENICI =====
    // BienIci is a SPA that loads data via API, so we call their API directly
    if (url.includes('bienici.com')) {
      try {
        // Extract ad ID from URL: /annonce/vente/city/type/rooms/AD_ID
        const urlParts = url.split('/');
        const adIdIndex = urlParts.findIndex(p => p.includes('pieces') || p.includes('piece'));
        let adId = null;
        
        if (adIdIndex !== -1 && urlParts[adIdIndex + 1]) {
          adId = urlParts[adIdIndex + 1].split('?')[0]; // Remove query params
        }
        
        if (!adId) {
          // Try alternative pattern - last path segment before query
          const pathMatch = url.match(/\/([^\/\?]+)(?:\?|$)/);
          if (pathMatch) {
            adId = pathMatch[1];
          }
        }
        
        console.log(`BienIci ad ID: ${adId}`);
        
        if (adId) {
          const apiUrl = `https://www.bienici.com/realEstateAd.json?id=${adId}`;
          console.log(`Fetching BienIci API: ${apiUrl}`);
          
          const adData = await fetchWithProxy(apiUrl, {
            accept: 'application/json',
            headers: { 'Referer': 'https://www.bienici.com/' }
          });
          
          console.log('BienIci API response keys:', Object.keys(adData));
          
          // Calculate monthly charges from annual if available
          let chargesCopro = adData.charges || adData.chargesPerMonth || null;
          if (!chargesCopro && adData.annualCondominiumFees) {
            chargesCopro = Math.round(adData.annualCondominiumFees / 12);
            console.log(`Converted annual charges ${adData.annualCondominiumFees}€/an to ${chargesCopro}€/mois`);
          }
          
          // Extract data directly from API response
          let data = {
            prix: adData.price || null,
            chargesCopro: chargesCopro,
            taxeFonciere: adData.propertyTax || null,
            nombreChambres: adData.bedroomsQuantity || null,
            surface: adData.surfaceArea || null,
            titre: adData.title || adData.description?.substring(0, 100) || null,
            ville: adData.city || null,
            codePostal: adData.postalCode || null
          };
          
          console.log('BienIci extracted data from API:', data);
          
          // If some fields are missing, try to extract from description using LLM
          const missingFields = !data.chargesCopro || !data.taxeFonciere || !data.nombreChambres;
          if (missingFields && adData.description) {
            console.log('Some fields missing, analyzing description with LLM...');
            try {
              const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                  {
                    role: 'system',
                    content: `Tu analyses la description d'une annonce immobilière pour extraire des informations manquantes.
Retourne UNIQUEMENT un objet JSON avec ces champs (null si non trouvé, ne jamais inventer):
{
  "chargesCopro": number | null,   // Charges de copropriété MENSUELLES en euros
  "taxeFonciere": number | null,   // Taxe foncière ANNUELLE en euros  
  "nombreChambres": number | null  // Nombre de chambres
}

Attention:
- Les charges peuvent être exprimées annuellement (divise par 12 pour obtenir mensuel)
- Cherche des patterns comme "charges: XXX€", "charges mensuelles", "charges de copropriété"
- Taxe foncière est généralement annuelle
- Ne confonds pas "pièces" et "chambres" - les chambres sont les pièces de nuit`
                  },
                  {
                    role: 'user',
                    content: `Description de l'annonce:\n\n${adData.description}`
                  }
                ],
                temperature: 0.1,
                max_tokens: 200
              });

              const llmContent = completion.choices[0].message.content;
              console.log('LLM response for description:', llmContent);
              
              const jsonMatch = llmContent.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const extracted = JSON.parse(jsonMatch[0]);
                // Merge only if API didn't have the value
                if (!data.chargesCopro && extracted.chargesCopro) {
                  data.chargesCopro = extracted.chargesCopro;
                  console.log('Extracted chargesCopro from description:', extracted.chargesCopro);
                }
                if (!data.taxeFonciere && extracted.taxeFonciere) {
                  data.taxeFonciere = extracted.taxeFonciere;
                  console.log('Extracted taxeFonciere from description:', extracted.taxeFonciere);
                }
                if (!data.nombreChambres && extracted.nombreChambres) {
                  data.nombreChambres = extracted.nombreChambres;
                  console.log('Extracted nombreChambres from description:', extracted.nombreChambres);
                }
              }
            } catch (llmError) {
              console.error('LLM extraction error:', llmError.message);
            }
          }
          
          console.log('BienIci final data:', data);
          
          return res.json({
            success: true,
            data
          });
        }
      } catch (bieniciError) {
        console.error('BienIci API error:', bieniciError.message);
        
        // Fallback: use ScrapingAnt or Jina Reader for BienIci
        try {
          console.log('Trying rendered content fetch for BienIci...');
          const textContent = await fetchRenderedContent(url);
          
          if (textContent.length > 200) {
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: `Tu extrais les informations d'une annonce immobilière BienIci.
Retourne UNIQUEMENT un objet JSON avec ces champs (null si non trouvé, ne jamais inventer):

{
  "prix": number | null,           // Prix de vente en euros
  "chargesCopro": number | null,   // Charges de copropriété mensuelles
  "taxeFonciere": number | null,   // Taxe foncière annuelle
  "nombreChambres": number | null, // Nombre de chambres
  "surface": number | null,        // Surface en m²
  "titre": string | null,
  "ville": string | null,
  "codePostal": string | null
}`
                },
                {
                  role: 'user',
                  content: `Annonce BienIci:\n\n${textContent.substring(0, 10000)}`
                }
              ],
              temperature: 0.1,
              max_tokens: 500
            });
            
            const content = completion.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const data = JSON.parse(jsonMatch[0]);
              console.log('BienIci rendered content extracted data:', data);
              return res.json({ success: true, data });
            }
          }
        } catch (fallbackError) {
          console.error('BienIci fallback error:', fallbackError.message);
        }
      }
    }

    // ===== REGULAR EXTRACTION FOR OTHER SITES =====
    const html = await fetchWithProxy(url);
    const $ = cheerio.load(html);

    let textContent = '';
    let jsonData = null;

    // ===== STRATEGY 1: Extract JSON from script tags (for SPAs like BienIci) =====
    const scriptContents = [];
    $('script').each((_, el) => {
      const scriptText = $(el).html() || '';
      
      // Look for __NEXT_DATA__ (Next.js apps)
      if (scriptText.includes('__NEXT_DATA__') || $(el).attr('id') === '__NEXT_DATA__') {
        try {
          const jsonStr = scriptText.trim();
          jsonData = JSON.parse(jsonStr);
          console.log('Found __NEXT_DATA__');
        } catch (e) {}
      }
      
      // Look for window.__INITIAL_STATE__ or similar patterns
      const statePatterns = [
        /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/,
        /window\.__DATA__\s*=\s*({[\s\S]*?});/,
        /window\.initialData\s*=\s*({[\s\S]*?});/,
        /"classifiedAd"\s*:\s*({[\s\S]*?})\s*[,}]/,
        /"ad"\s*:\s*({[\s\S]*?})\s*[,}]/
      ];
      
      for (const pattern of statePatterns) {
        const match = scriptText.match(pattern);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            if (parsed && typeof parsed === 'object') {
              scriptContents.push(JSON.stringify(parsed).substring(0, 8000));
              console.log('Found embedded JSON data');
            }
          } catch (e) {}
        }
      }
      
      // For BienIci: look for the ad data in any large JSON object
      if (url.includes('bienici.com') && scriptText.length > 500) {
        // Try to find price, surface patterns in script
        const priceMatch = scriptText.match(/"price"\s*:\s*(\d+)/);
        const surfaceMatch = scriptText.match(/"surfaceArea"\s*:\s*([\d.]+)/);
        const roomsMatch = scriptText.match(/"roomsQuantity"\s*:\s*(\d+)/);
        const bedroomsMatch = scriptText.match(/"bedroomsQuantity"\s*:\s*(\d+)/);
        const chargesMatch = scriptText.match(/"charges"\s*:\s*(\d+)/);
        const cityMatch = scriptText.match(/"city"\s*:\s*"([^"]+)"/);
        const postalCodeMatch = scriptText.match(/"postalCode"\s*:\s*"([^"]+)"/);
        const titleMatch = scriptText.match(/"title"\s*:\s*"([^"]+)"/);
        
        if (priceMatch || surfaceMatch) {
          const extractedData = {
            prix: priceMatch ? parseInt(priceMatch[1]) : null,
            surface: surfaceMatch ? parseFloat(surfaceMatch[1]) : null,
            nombrePieces: roomsMatch ? parseInt(roomsMatch[1]) : null,
            nombreChambres: bedroomsMatch ? parseInt(bedroomsMatch[1]) : null,
            charges: chargesMatch ? parseInt(chargesMatch[1]) : null,
            ville: cityMatch ? cityMatch[1] : null,
            codePostal: postalCodeMatch ? postalCodeMatch[1] : null,
            titre: titleMatch ? titleMatch[1] : null
          };
          scriptContents.push('Données extraites BienIci: ' + JSON.stringify(extractedData));
          console.log('Extracted BienIci data from script:', extractedData);
        }
      }
    });

    // ===== STRATEGY 2: Look for JSON-LD structured data =====
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const jsonLd = JSON.parse($(el).html());
        if (jsonLd['@type'] === 'Product' || jsonLd['@type'] === 'RealEstateListing' || jsonLd['@type'] === 'Residence') {
          scriptContents.push('JSON-LD: ' + JSON.stringify(jsonLd).substring(0, 3000));
          console.log('Found JSON-LD structured data');
        }
      } catch (e) {}
    });

    // ===== STRATEGY 3: Extract from meta tags =====
    const metaData = {};
    $('meta[property^="og:"], meta[name^="twitter:"]').each((_, el) => {
      const name = $(el).attr('property') || $(el).attr('name');
      const content = $(el).attr('content');
      if (name && content) {
        metaData[name] = content;
      }
    });
    if (Object.keys(metaData).length > 0) {
      scriptContents.push('Meta tags: ' + JSON.stringify(metaData));
    }

    // Now remove scripts for text extraction
    $('script').remove();
    $('style').remove();
    $('noscript').remove();
    $('iframe').remove();
    $('svg').remove();
    
    // ===== STRATEGY 4: Extract visible text content =====
    const selectors = [
      // BienIci
      '.detailedSheetOffer',
      '.mainInfosContent',
      '.allDetails',
      '.detailedSheetBox',
      '[class*="detail"]',
      '[class*="Description"]',
      '[class*="caracteristique"]',
      // SeLoger
      '.Summarystyled__Summary',
      '[class*="Summary"]',
      '[class*="Criterion"]',
      '[class*="Price"]',
      '[data-test*="price"]',
      '[class*="Feature"]',
      // Generic
      'main',
      'article',
      '.content',
      '#content'
    ];

    for (const selector of selectors) {
      $(selector).each((_, el) => {
        textContent += $(el).text() + '\n';
      });
    }

    // If we didn't get much visible text, fall back to body
    if (textContent.length < 500) {
      textContent = $('body').text();
    }

    // Combine script JSON data with text content
    const combinedContent = [
      ...scriptContents,
      'Contenu visible de la page:',
      textContent
    ].join('\n\n');

    // Clean up whitespace
    textContent = combinedContent
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .substring(0, 15000); // Limit to avoid token limits

    console.log(`Extracted ${textContent.length} characters of text`);

    // Use OpenAI to extract structured data
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Tu es un assistant spécialisé dans l'extraction d'informations immobilières.
Extrait les informations suivantes d'une annonce immobilière française.
Retourne UNIQUEMENT un objet JSON valide avec ces champs (null si non trouvé, ne jamais inventer):

{
  "prix": number | null,           // Prix de vente en euros
  "chargesCopro": number | null,   // Charges de copropriété mensuelles en euros
  "taxeFonciere": number | null,   // Taxe foncière annuelle en euros
  "nombreChambres": number | null, // Nombre de chambres
  "surface": number | null,        // Surface en m²
  "titre": string | null,          // Titre ou description courte de l'annonce
  "ville": string | null,          // Ville
  "codePostal": string | null      // Code postal
}

Important:
- Prix: cherche le prix de vente, pas les loyers
- Charges: charges mensuelles de copropriété
- Ne jamais halluciner, retourne null si l'info n'est pas clairement présente
- Les montants doivent être des nombres, pas des strings`
        },
        {
          role: 'user',
          content: `Extrait les informations de cette annonce immobilière:\n\n${textContent}`
        }
      ],
      temperature: 0.1,
      max_tokens: 500
    });

    const content = completion.choices[0].message.content;
    console.log('OpenAI response:', content);

    // Parse the JSON response
    let data;
    try {
      // Try to extract JSON from the response (handle markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', parseError);
      return res.status(500).json({ 
        error: 'Failed to parse property data',
        raw: content
      });
    }

    res.json({
      success: true,
      data: {
        prix: data.prix,
        chargesCopro: data.chargesCopro,
        taxeFonciere: data.taxeFonciere,
        nombreChambres: data.nombreChambres,
        surface: data.surface,
        titre: data.titre,
        ville: data.ville,
        codePostal: data.codePostal
      }
    });

  } catch (error) {
    console.error('Error extracting property data:', error.message);
    
    if (error.response) {
      // HTTP error from axios
      res.status(500).json({ 
        error: `Failed to fetch URL: ${error.response.status} ${error.response.statusText}`
      });
    } else if (error.code === 'ECONNABORTED') {
      res.status(500).json({ error: 'Request timeout - the website took too long to respond' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
