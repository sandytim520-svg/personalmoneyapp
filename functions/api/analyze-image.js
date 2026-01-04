// Cloudflare Pages Function for analyzing bank transaction images
// Using OpenRouter API with multiple free vision models (with fallback)
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

        const { image, prompt, members, currency } = await request.json();

        if (!image) {
            return new Response(JSON.stringify({ error: 'No image provided' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Ensure image has proper data URL format
        let imageUrl = image;
        if (!image.startsWith('data:')) {
            imageUrl = `data:image/jpeg;base64,${image}`;
        }

        console.log('Calling OpenRouter API...');
        console.log('User Prompt:', prompt);
        console.log('Members:', members);

        const memberListStr = members && members.length > 0 ? members.join(', ') : 'No specific members provided';
        const currencyStr = currency || 'TWD';

        const systemPrompt = `You are a financial transaction analyzer. Analyze this image of bank statement, receipt, or transaction list.

Valid Members: [${memberListStr}]
Currency: ${currencyStr}

USER INSTRUCTIONS: "${prompt || 'None'}"

Task:
1. Extract ALL visible transactions: date, description/merchant, amount.
2. Apply USER INSTRUCTIONS to determine payer and involved members.
3. Default: payer = first member, involved = all members.

IMPORTANT: Respond with ONLY a valid JSON array. No explanations, no markdown.

Format:
[{"date":"YYYY-MM-DD","description":"Item Name","category":"food","amount":100.00,"type":"expense","payer":"MemberName","involved":["Member1","Member2"],"splitType":"equal"}]

Categories: food, transport, groceries, shopping, entertainment, health, education, accommodation, transfers, travel, communication, other

If no transactions visible, return: []`;

        // List of free vision models to try (in order of preference)
        const freeModels = [
            'qwen/qwen2.5-vl-72b-instruct:free',
            'meta-llama/llama-4-maverick:free',
            'nvidia/llama-3.1-nemotron-70b-instruct:free',
            'nvidia/llama-3.3-nemotron-super-49b-v1:free',
            'google/gemma-3-27b-it:free',
            'google/gemini-2.0-flash-exp:free'
        ];

        let lastError = null;
        let usedModel = null;

        for (const model of freeModels) {
            console.log(`Trying model: ${model}`);

            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                        'HTTP-Referer': 'https://personalmoneyapp.pages.dev',
                        'X-Title': 'Personal Money App'
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [
                            {
                                role: 'user',
                                content: [
                                    {
                                        type: 'text',
                                        text: systemPrompt
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
                        temperature: 0.1,
                        max_tokens: 2000
                    })
                });

                if (response.ok) {
                    const data = await response.json();

                    if (data.choices && data.choices[0] && data.choices[0].message) {
                        usedModel = model;
                        const content = data.choices[0].message.content;
                        console.log(`Success with ${model}:`, content);

                        const transactions = parseTransactions(content, members);

                        return new Response(JSON.stringify({
                            success: transactions.length > 0,
                            transactions: transactions,
                            count: transactions.length,
                            source: model
                        }), {
                            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                        });
                    }
                } else {
                    const errorText = await response.text();
                    console.log(`Model ${model} failed:`, response.status, errorText);
                    lastError = { status: response.status, text: errorText };

                    // If rate limited, try next model
                    if (response.status === 429) {
                        continue;
                    }
                }
            } catch (modelError) {
                console.error(`Error with ${model}:`, modelError);
                lastError = { message: modelError.message };
                continue;
            }
        }

        // All models failed
        return new Response(JSON.stringify({
            error: 'All AI models are currently unavailable. Please try again in a few minutes.',
            details: lastError,
            success: false,
            transactions: []
        }), {
            status: 503,
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

function parseTransactions(content, members) {
    try {
        let jsonStr = content.trim();

        // Remove markdown code blocks if present
        if (jsonStr.startsWith('```json')) {
            jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }

        // Try to find JSON array in the response
        const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            jsonStr = jsonMatch[0];
        }

        const parsed = JSON.parse(jsonStr);
        const txArray = Array.isArray(parsed) ? parsed : (parsed.transactions || []);

        let transactions = txArray
            .filter(tx => tx.amount && parseFloat(tx.amount) > 0 && tx.description)
            .map(tx => ({
                date: normalizeDate(tx.date),
                description: tx.description,
                category: mapCategory(tx.description, tx.category),
                amount: Math.round(parseFloat(tx.amount) * 100) / 100,
                txType: tx.type === 'income' ? 'income' : 'expense',
                payer: tx.payer || (members && members[0]) || '',
                involved: tx.involved || members || [],
                splitType: tx.splitType || 'equal'
            }));

        // Deduplicate
        transactions = transactions.filter((item, index, self) =>
            index === self.findIndex(t =>
                t.date === item.date &&
                t.description === item.description &&
                Math.abs(t.amount - item.amount) < 0.01
            )
        );

        return transactions;
    } catch (parseError) {
        console.error('Parse error:', parseError, 'Content:', content);
        return [];
    }
}

function normalizeDate(dateStr) {
    if (!dateStr) return new Date().toISOString().split('T')[0];

    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return dateStr;
    }

    // Handle MM/DD format
    const mmddMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (mmddMatch) {
        const month = mmddMatch[1].padStart(2, '0');
        const day = mmddMatch[2].padStart(2, '0');
        const year = new Date().getFullYear();
        return `${year}-${month}-${day}`;
    }

    // Handle YYYY/MM/DD format
    const slashMatch = dateStr.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (slashMatch) {
        return `${slashMatch[1]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[3].padStart(2, '0')}`;
    }

    return new Date().toISOString().split('T')[0];
}

function mapCategory(name, originalCat) {
    const lowerName = (name || '').toLowerCase();
    const lowerCat = (originalCat || '').toLowerCase();

    if (lowerName.includes('esim') || lowerName.includes('sim')) return 'communication';
    if (lowerName.includes('票') || lowerName.includes('ticket')) return 'travel';
    if (lowerName.includes('環球') || lowerName.includes('universal')) return 'entertainment';
    if (lowerName.includes('周遊券') || lowerName.includes('pass')) return 'travel';
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
    if (lowerCat.includes('travel')) return 'travel';

    if (lowerName.includes('kfc') || lowerName.includes('mcdonald') || lowerName.includes('cafe')) return 'food';
    if (lowerName.includes('mart') || lowerName.includes('coles') || lowerName.includes('woolworths')) return 'groceries';
    if (lowerName.includes('target')) return 'shopping';

    return originalCat || 'other';
}
