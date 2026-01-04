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
        if (!env.GROQ_API_KEY) {
            return new Response(JSON.stringify({
                error: 'GROQ_API_KEY not configured',
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
            imageUrl = `data:image/png;base64,${image}`;
        }

        console.log('Calling OpenRouter API...');
        console.log('User Prompt:', prompt);
        console.log('Members:', members);

        const memberListStr = members && members.length > 0 ? members.join(', ') : 'No specific members provided';
        const currencyStr = currency || 'TWD';

        // Call Groq API (High Speed + Vision)
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama-3.2-11b-vision-preview',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Analyze this bank app screenshot or receipt.
Valid Members for this ledger: [${memberListStr}]
Currency: ${currencyStr}

USER INSTRUCTIONS: 
"${prompt || 'None'}"

Task:
1. Extract visible transactions (date, merchant, amount).
2. Apply USER INSTRUCTIONS to modify 'payer', 'involved' list, or 'description' if specified.
3. If no user instructions, use defaults (payer=unknown, split=equal).

[{
  "date": "YYYY-MM-DD",
  "description": "Item Name", 
  "category": "food/transport/etc", 
  "amount": 100.00, 
  "type": "expense",
  "payer": "MemberName",
  "involved": ["MemberA", "MemberB"],
  "splitType": "equal"
}]

IMPORTANT:
- First, extract the transaction details from the image.
- Then, apply the USER INSTRUCTIONS (if any) to set 'payer', 'involved', or 'description'.
- If the USER INSTRUCTIONS are empty or unclear, ignore them and just extract the transaction.
- Always return valid JSON.`
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

                const jsonMatch = cleanContent.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);

                    transactions = parsed
                        .filter(tx => tx.amount && parseFloat(tx.amount) > 0 && tx.description)
                        .map(tx => ({
                            date: tx.date || new Date().toISOString().split('T')[0],
                            description: tx.description,
                            category: mapCategory(tx.description, tx.category),
                            amount: Math.round(parseFloat(tx.amount) * 100) / 100,
                            txType: tx.type === 'income' ? 'income' : 'expense',
                            payer: tx.payer || (members && members[0]) || '',
                            involved: tx.involved || members || [],
                            splitType: tx.splitType || 'equal'
                        }));

                    transactions = transactions.filter((item, index, self) =>
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
