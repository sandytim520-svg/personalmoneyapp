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
        if (!env.GEMINI_API_KEY) {
            return new Response(JSON.stringify({
                error: 'GEMINI_API_KEY not configured',
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

        // Parse base64 image
        // Input is likely "data:image/jpeg;base64,..."
        const match = image.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
        let mimeType = 'image/jpeg'; // Default
        let base64Data = image;

        if (match) {
            mimeType = match[1];
            base64Data = match[2];
        } else if (image.startsWith('data:')) {
            // Handle simple split if regex fails but header exists
            const parts = image.split(',');
            if (parts.length === 2) {
                const header = parts[0];
                const mimeMatch = header.match(/:(.*?);/);
                if (mimeMatch) mimeType = mimeMatch[1];
                base64Data = parts[1];
            }
        }

        console.log('Calling Google Gemini API...');
        console.log('User Prompt:', prompt);
        console.log('Members:', members);

        const memberListStr = members && members.length > 0 ? members.join(', ') : 'No specific members provided';
        const currencyStr = currency || 'TWD';

        const systemPrompt = `Analyze this bank app screenshot or receipt.
Valid Members for this ledger: [${memberListStr}]
Currency: ${currencyStr}

USER INSTRUCTIONS: 
"${prompt || 'None'}"

Task:
1. Extract visible transactions (date, merchant, amount).
2. Apply USER INSTRUCTIONS to modify 'payer', 'involved' list, or 'description' if specified.
3. If no user instructions, use defaults (payer=unknown, split=equal).

Return JSON Array ONLY:
[{
  "date": "YYYY-MM-DD",
  "description": "Item Name", 
  "category": "food/transport/etc", 
  "amount": 100.00, 
  "type": "expense",
  "payer": "MemberName",
  "involved": ["MemberA", "MemberB"],
  "splitType": "equal"
}]`;

        // Call Google Gemini API (using gemini-2.0-flash-001 - stable model)
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': env.GEMINI_API_KEY
            },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: systemPrompt },
                        {
                            inline_data: {
                                mime_type: mimeType,
                                data: base64Data
                            }
                        }
                    ]
                }],
                generationConfig: {
                    response_mime_type: "application/json"
                }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Gemini API error:', response.status, errorText);
            return new Response(JSON.stringify({
                error: `Gemini API error: ${response.status}`,
                details: errorText,
                success: false,
                transactions: []
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const data = await response.json();
        console.log('Gemini Response received');

        let transactions = [];

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            const content = data.candidates[0].content.parts[0].text;
            console.log('AI Content:', content);

            try {
                // Gemini usually returns clean JSON if response_mime_type is set, but parsing is safe
                const parsed = JSON.parse(content);

                // Handle if it returns an object with a "transactions" key or just the array
                const txArray = Array.isArray(parsed) ? parsed : (parsed.transactions || []);

                transactions = txArray
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

                // Deduplicate simple
                transactions = transactions.filter((item, index, self) =>
                    index === self.findIndex(t =>
                        t.date === item.date &&
                        t.description === item.description &&
                        Math.abs(t.amount - item.amount) < 0.01
                    )
                );
            } catch (parseError) {
                console.error('Parse error:', parseError);
            }
        }

        return new Response(JSON.stringify({
            success: transactions.length > 0,
            transactions: transactions,
            count: transactions.length,
            source: 'gemini-2.0-flash'
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
