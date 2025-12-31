// Cloudflare Pages Function for analyzing bank transaction images
// Using Google Gemini 2.0 Flash (FREE)
// File: functions/api/analyze-image.js

export async function onRequest(context) {
    const { request, env } = context;
    
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // Handle GET (for testing)
    if (request.method === 'GET') {
        return new Response(JSON.stringify({ 
            status: 'ok', 
            message: 'Gemini API endpoint ready',
            hasApiKey: !!env.GEMINI_API_KEY
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Handle POST
    if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        // Check API key
        if (!env.GEMINI_API_KEY) {
            console.error('GEMINI_API_KEY not configured');
            return new Response(JSON.stringify({ 
                error: 'API key not configured. Please add GEMINI_API_KEY to Cloudflare environment variables.',
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

        // Extract base64 data - handle different formats
        let mimeType = 'image/png';
        let base64Data = '';
        
        if (image.startsWith('data:')) {
            const commaIndex = image.indexOf(',');
            if (commaIndex === -1) {
                return new Response(JSON.stringify({ error: 'Invalid data URL format' }), {
                    status: 400,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }
            
            const header = image.substring(0, commaIndex);
            base64Data = image.substring(commaIndex + 1);
            
            const mimeMatch = header.match(/data:([^;]+)/);
            if (mimeMatch) {
                mimeType = mimeMatch[1];
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

        console.log('Image mime type:', mimeType);
        console.log('Base64 data length:', base64Data.length);

        // Call Google Gemini 2.0 Flash API
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`;
        
        console.log('Calling Gemini 2.0 Flash API...');
        
        const geminiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        {
                            text: `You are a bank transaction extractor. Analyze this CommBank app screenshot carefully.

TASK: Extract every visible transaction into a JSON array.

For each transaction row, extract:
1. date: Look for date headers like "Sun 02 Nov 2025" → convert to "2025-11-02"
2. description: The merchant name (first line of each transaction)
3. category: The category text below merchant name (like "Groceries", "Eating out & takeaway")  
4. amount: The dollar amount as a number (e.g., 24.35 from "-$24.35")
5. type: "expense" if shows "-$", "income" if no minus sign or green colored

RULES:
- SKIP any transaction where amount is covered/hidden by a yellow button
- Do NOT invent transactions - only extract what's visible
- Keep exact decimals (24.35 not 24)
- Each transaction appears once only

OUTPUT FORMAT - Return ONLY this JSON array, nothing else:
[{"date":"2025-11-02","description":"KFC (Sebastopol)","category":"Eating out & takeaway","amount":24.35,"type":"expense"}]

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
                let cleanContent = content.trim();
                cleanContent = cleanContent.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
                
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
                    
                    console.log('Parsed transactions:', transactions.length);
                }
            } catch (parseError) {
                console.error('JSON Parse error:', parseError);
            }
        } else {
            console.error('No candidates in response:', JSON.stringify(geminiData));
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

// Custom category mapping
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
    if (lowerName.includes('mart') || lowerName.includes('coles') || lowerName.includes('woolworths') || lowerName.includes('sunlit') || lowerName.includes('hanaro') || lowerName.includes('metro')) return 'groceries';
    if (lowerName.includes('target')) return 'shopping';
    
    return 'other';
}
