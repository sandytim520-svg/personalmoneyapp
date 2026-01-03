// Cloudflare Pages Function for analyzing bank transaction images
// Using OpenRouter Free API (Multiple free models available)
// File: functions/api/analyze-image.js

export async function onRequest(context) {
    const { request, env } = context;

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'GET') {
        return new Response(JSON.stringify({
            status: 'ok',
            message: 'OpenRouter API ready',
            hasApiKey: !!env.OPENROUTER_API_KEY
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        if (!env.OPENROUTER_API_KEY) {
            return new Response(JSON.stringify({
                error: 'OPENROUTER_API_KEY not configured',
                success: false,
                transactions: []
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const { image, prompt } = await request.json();

        if (!image) {
            return new Response(JSON.stringify({ error: 'No image provided' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Ensure image has proper data URL format
        let imageUrl = image;
        if (!image.startsWith('data:')) {
            imageUrl = `data:image/png;base64,${image}`;
        }

        console.log('Calling OpenRouter API...');
        console.log('User prompt:', prompt || '(none)');

        // Build the AI prompt based on whether user provided custom instructions
        let aiPrompt = '';

        if (prompt && prompt.trim()) {
            // User provided AB split or custom instructions
            aiPrompt = `Analyze this image and follow the user's instructions.

USER INSTRUCTIONS: "${prompt}"

If the user mentions AB split (AB分), custom split, or specifies amounts per person, return transactions in this format:
{
  "transactions": [{
    "date": "2025-01-04",
    "description": "Overall item description",
    "amount": 150,
    "splitType": "custom",
    "payer": "the person who paid (extract from prompt)",
    "customItems": {
      "PersonA": [{"name": "item name", "amount": 50}],
      "PersonB": [{"name": "item name", "amount": 50}],
      "PersonC": [{"name": "item name", "amount": 25}],
      "PersonD": [{"name": "item name", "amount": 25}]
    }
  }]
}

If the user just wants normal transaction extraction from a bank screenshot, use:
{
  "transactions": [{
    "date": "2025-01-04",
    "description": "Merchant name",
    "category": "food",
    "amount": 24.35,
    "type": "expense"
  }]
}

Extract the date from the image if visible. Parse amounts and names from the user's instructions.
Return ONLY valid JSON, no other text.`;
        } else {
            // Standard bank transaction extraction
            aiPrompt = `Analyze this bank app screenshot and extract ALL visible transactions.

For each transaction, extract:
- date: Convert "Sun 02 Nov 2025" to "2025-11-02"
- description: The merchant name exactly as shown
- category: The category text below the merchant name
- amount: The dollar amount as number (24.35 from "-$24.35")
- type: "expense" if minus sign, "income" if no minus

RULES:
- SKIP transactions where amount is hidden by buttons
- Keep exact decimal amounts
- Each transaction once only

Return ONLY a JSON object with transactions array:
{"transactions": [{"date":"2025-11-02","description":"KFC","category":"Eating out","amount":24.35,"type":"expense"}]}`;
        }

        // Call OpenRouter API with free model
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://personalmoneyapp.pages.dev',
                'X-Title': 'Personal Money App'
            },
            body: JSON.stringify({
                model: 'nvidia/nemotron-nano-12b-v2-vl:free',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: aiPrompt
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: imageUrl
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 4096,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenRouter API error:', response.status, errorText);
            return new Response(JSON.stringify({
                error: `OpenRouter API error: ${response.status}`,
                details: errorText,
                success: false,
                transactions: []
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const data = await response.json();
        console.log('OpenRouter Response received');

        let transactions = [];

        if (data.choices && data.choices[0] && data.choices[0].message) {
            const content = data.choices[0].message.content;
            console.log('AI Content:', content);

            try {
                let cleanContent = content.trim().replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

                // Try to parse as object first (new format with transactions array)
                let parsed = null;
                const objMatch = cleanContent.match(/\{[\s\S]*\}/);
                const arrMatch = cleanContent.match(/\[[\s\S]*\]/);

                if (objMatch) {
                    try {
                        parsed = JSON.parse(objMatch[0]);
                        if (parsed.transactions && Array.isArray(parsed.transactions)) {
                            parsed = parsed.transactions;
                        } else if (!Array.isArray(parsed)) {
                            parsed = [parsed];
                        }
                    } catch (e) {
                        // Try array format
                        if (arrMatch) {
                            parsed = JSON.parse(arrMatch[0]);
                        }
                    }
                } else if (arrMatch) {
                    parsed = JSON.parse(arrMatch[0]);
                }

                if (parsed && Array.isArray(parsed)) {
                    transactions = parsed
                        .filter(tx => tx.amount && parseFloat(tx.amount) > 0 && tx.description)
                        .map(tx => {
                            // Handle AB split / custom split response
                            if (tx.splitType === 'custom' && tx.customItems) {
                                return {
                                    date: tx.date || new Date().toISOString().split('T')[0],
                                    description: tx.description,
                                    amount: Math.round(parseFloat(tx.amount) * 100) / 100,
                                    splitType: 'custom',
                                    payer: tx.payer || '',
                                    customItems: tx.customItems,
                                    txType: tx.type === 'income' ? 'income' : 'expense'
                                };
                            }
                            // Standard transaction
                            return {
                                date: tx.date || new Date().toISOString().split('T')[0],
                                description: tx.description,
                                category: mapCategory(tx.description, tx.category),
                                amount: Math.round(parseFloat(tx.amount) * 100) / 100,
                                txType: tx.type === 'income' ? 'income' : 'expense'
                            };
                        });

                    // Remove duplicates for non-custom transactions only
                    transactions = transactions.filter((item, index, self) =>
                        item.splitType === 'custom' ||
                        index === self.findIndex(t =>
                            t.date === item.date &&
                            t.description === item.description &&
                            Math.abs(t.amount - item.amount) < 0.01
                        )
                    );
                }
            } catch (parseError) {
                console.error('Parse error:', parseError);
            }
        }

        return new Response(JSON.stringify({
            success: transactions.length > 0,
            transactions: transactions,
            count: transactions.length,
            source: 'openrouter-nvidia-nemotron-vl'
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Error:', error);
        return new Response(JSON.stringify({
            error: error.message,
            success: false,
            transactions: []
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

function mapCategory(name, originalCat) {
    const lowerName = (name || '').toLowerCase();
    const lowerCat = (originalCat || '').toLowerCase();

    if (lowerName.includes('tangerpay')) return 'laundry';
    if (lowerName.includes('qut') || lowerName.includes('queensland university')) return 'education';
    if (lowerName.includes('iglu')) return 'accommodation';

    if (lowerCat.includes('eating out') || lowerCat.includes('takeaway')) return 'food';
    if (lowerCat.includes('groceries')) return 'groceries';
    if (lowerCat.includes('education')) return 'education';
    if (lowerCat.includes('shopping')) return 'shopping';
    if (lowerCat.includes('transfer') || lowerCat.includes('payment')) return 'transfers';
    if (lowerCat.includes('entertainment')) return 'entertainment';
    if (lowerCat.includes('transport')) return 'vehicle';
    if (lowerCat.includes('health')) return 'health';

    if (lowerName.includes('kfc') || lowerName.includes('mcdonald') || lowerName.includes('cafe')) return 'food';
    if (lowerName.includes('mart') || lowerName.includes('coles') || lowerName.includes('woolworths')) return 'groceries';
    if (lowerName.includes('target')) return 'shopping';

    return 'other';
}
