// Cloudflare Pages Function for analyzing bank transaction images
// Using Google Gemini 1.5 Flash (FREE)
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
            message: 'Gemini 1.5 Flash API ready',
            hasApiKey: !!env.GEMINI_API_KEY
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

        const { image } = await request.json();
        
        if (!image) {
            return new Response(JSON.stringify({ error: 'No image provided' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Extract base64 data and mime type
        let mimeType = 'image/png';
        let base64Data = '';
        
        if (image.startsWith('data:')) {
            const commaIndex = image.indexOf(',');
            if (commaIndex !== -1) {
                const header = image.substring(0, commaIndex);
                base64Data = image.substring(commaIndex + 1);
                const mimeMatch = header.match(/data:([^;]+)/);
                if (mimeMatch) mimeType = mimeMatch[1];
            }
        } else {
            base64Data = image;
        }

        if (!base64Data) {
            return new Response(JSON.stringify({ error: 'No base64 data found' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        console.log('Calling Gemini 1.5 Flash API...');

        // Call Gemini 1.5 Flash API
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
        
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        {
                            text: `Analyze this bank app screenshot and extract ALL visible transactions.

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

Return ONLY a JSON array:
[{"date":"2025-11-02","description":"KFC (Sebastopol)","category":"Eating out","amount":24.35,"type":"expense"}]

If no transactions visible, return: []`
                        },
                        {
                            inlineData: {
                                mimeType: mimeType,
                                data: base64Data
                            }
                        }
                    ]
                }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 4096
                }
            })
        });

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            console.error('Gemini API error:', geminiResponse.status, errorText);
            return new Response(JSON.stringify({ 
                error: `Gemini API error: ${geminiResponse.status}`,
                details: errorText,
                success: false,
                transactions: []
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        const geminiData = await geminiResponse.json();
        console.log('Gemini Response received');

        let transactions = [];
        
        if (geminiData.candidates && geminiData.candidates[0] && geminiData.candidates[0].content) {
            const content = geminiData.candidates[0].content.parts[0].text;
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
                            txType: tx.type === 'income' ? 'income' : 'expense'
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
            source: 'gemini-1.5-flash'
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
