import React, { useState, useRef, useEffect } from 'react';
import { Upload, Image as ImageIcon, MessageSquare, Database, PlusCircle, Save, Trash2, RefreshCw, CheckCircle, AlertCircle, Home, Cloud, Search, Download, Settings } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';

// API Retry Utility
const fetchWithRetry = async (url, options, retries = 5) => {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
};

// --- Firebase Initialization ---
let app, auth, db, appId = 'my-shop-assistant';

try {
  let configObj = null;
  // 檢查是否在 Vercel 或其他本地環境，讀取用戶自訂的設定
  const customConfig = localStorage.getItem('custom_firebase_config');
  
  if (typeof __firebase_config !== 'undefined' && __firebase_config) {
    // Canvas 環境
    configObj = JSON.parse(__firebase_config);
    appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
  } else if (customConfig) {
    // Vercel 且用戶有輸入自訂設定
    configObj = JSON.parse(customConfig);
  }

  if (configObj) {
    app = initializeApp(configObj);
    auth = getAuth(app);
    db = getFirestore(app);
  }
} catch (e) {
  console.error("Firebase init error:", e);
}

// 圖片壓縮工具
const compressImage = (dataUrl, callback) => {
  const img = new window.Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const MAX_WIDTH = 400; 
    const MAX_HEIGHT = 400;
    let width = img.width;
    let height = img.height;

    if (width > height) {
      if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
    } else {
      if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
    }
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    callback(canvas.toDataURL('image/jpeg', 0.6)); 
  };
  img.src = dataUrl;
};

export default function App() {
  const [activeTab, setActiveTab] = useState('upload'); // 'upload', 'database', 'settings'
  
  // States for Upload Tab
  const [chatImage, setChatImage] = useState(null);
  const [chatMimeType, setChatMimeType] = useState(null);
  const [productImage, setProductImage] = useState(null);
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);
  const [analyzeSuccess, setAnalyzeSuccess] = useState(false);
  
  const [formData, setFormData] = useState({
    productName: '',
    chatTime: '',
    sizes: '',
    cutoffTime: '',
    exchangeRate: 4.9,
    sellMultiplier: 4.6,
    fullChatText: '',
    variants: [{ style: '', costCny: '', limitCny: '', limitOverseasCny: '' }] 
  });

  // State for Database Tab
  const [database, setDatabase] = useState([]);
  const [user, setUser] = useState(null);
  const [isSyncing, setIsSyncing] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  // State for Settings Tab
  const [geminiKeyInput, setGeminiKeyInput] = useState(localStorage.getItem('custom_gemini_api_key') || '');
  const [firebaseConfigInput, setFirebaseConfigInput] = useState(localStorage.getItem('custom_firebase_config') || '');

  // --- Firebase Auth Setup ---
  useEffect(() => {
    if (!auth) {
      setIsSyncing(false);
      return;
    }
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Auth error:", error);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // --- Firebase Data Sync ---
  useEffect(() => {
    if (!user || !db) {
      setIsSyncing(false);
      return;
    }
    setIsSyncing(true);
    const productsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'products');
    
    const unsubscribe = onSnapshot(productsRef, (snapshot) => {
      const items = [];
      snapshot.forEach((doc) => {
        items.push({ id: doc.id, ...doc.data() });
      });
      items.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      setDatabase(items);
      setIsSyncing(false);
    }, (error) => {
      console.error("Firestore sync error:", error);
      setIsSyncing(false);
    });

    return () => unsubscribe();
  }, [user]);

  // Handle Image Upload
  const handleImageUpload = (e, type) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target.result;
      if (type === 'chat') {
        const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.-]+);base64,(.*)$/);
        if (match) {
          setChatMimeType(match[1]);
          setChatImage(dataUrl);
          setAnalyzeSuccess(false);
        }
      } else if (type === 'product') {
        compressImage(dataUrl, (compressedUrl) => {
          setProductImage(compressedUrl);
        });
      }
    };
    reader.readAsDataURL(file);
  };

  // Analyze Chat Image using Gemini API
  const analyzeChatImage = async () => {
    if (!chatImage || !chatMimeType) {
      setAnalyzeError("請先上傳廠商對話截圖！");
      return;
    }

    // 檢查是否有 API Key (自訂或由 Canvas 代理)
    const customApiKey = localStorage.getItem('custom_gemini_api_key');
    const isCanvasEnv = typeof __firebase_config !== 'undefined';
    
    if (!customApiKey && !isCanvasEnv) {
      setAnalyzeError("請先至「⚙️ 設定」分頁輸入你的 Gemini API Key！");
      return;
    }

    const apiKey = customApiKey || "";

    setIsAnalyzing(true);
    setAnalyzeError(null);
    setAnalyzeSuccess(false);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
      const base64Data = chatImage.split(',')[1];

      const prompt = `這是一張廠商對話截圖，請從中擷取商品上架所需的資訊。
      請盡可能找出：
      1. 建檔時效 (對話時間)：請嚴格格式化為「月/日-小時」，例如截圖中的手機時間08:14，今天是4/19，請寫成 "4/19-08"。
      2. 提到的商品名稱：請簡短扼要（例如 "Minecraft 新款童裝"），**絕對不要**包含具體的款式名稱（請把「半袖」、「褲子」從主名稱中去掉）。
      3. 尺寸範圍 (例如 "80-140")
      4. 截單時間 (例如 "截單後一個多月出")
      5. 款式與價格清單 (variants)：請列出所有提到的款式群組，以及對應的拿貨價(costCny)、限價(limitCny)與限價+海外(limitOverseasCny)。例如截圖寫「限價48¥/58¥」，則 limitCny=48，limitOverseasCny=58。若只提供一個限價數字，limitOverseasCny 預設為該限價+10。請分開不同價位的群組。
      6. 完整廠商對話原文：請將截圖中廠商發送的文字對話內容，完整、一字不漏地轉錄。
      如果找不到特定資訊，請留空或回傳 null。`;

      const payload = {
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: chatMimeType, data: base64Data } }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              chatTime: { type: "STRING", description: "月/日-小時，例如 4/19-08" },
              productName: { type: "STRING", description: "簡短主商品名稱，絕不含款式描述(如半袖)" },
              sizes: { type: "STRING", description: "尺寸範圍" },
              cutoffTime: { type: "STRING", description: "截單時間或預期出貨" },
              fullChatText: { type: "STRING", description: "廠商對話完整原文轉錄" },
              variants: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    style: { type: "STRING", description: "款式，如 A1.A2" },
                    costCny: { type: "NUMBER", description: "拿貨價/成本價 (CNY)" },
                    limitCny: { type: "NUMBER", description: "限價 (CNY)" },
                    limitOverseasCny: { type: "NUMBER", description: "限價+海外 (CNY)" }
                  }
                }
              }
            }
          }
        }
      };

      const result = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const extractedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!extractedText) throw new Error("AI 未回傳任何資料");

      const data = JSON.parse(extractedText);
      
      setFormData({
        productName: data.productName || '自動擷取商品',
        chatTime: data.chatTime || '',
        sizes: data.sizes || '',
        cutoffTime: data.cutoffTime || '',
        exchangeRate: 4.9, 
        sellMultiplier: 4.6, 
        fullChatText: data.fullChatText || '',
        variants: data.variants && data.variants.length > 0 ? data.variants : [{ style: '', costCny: '', limitCny: '', limitOverseasCny: '' }]
      });
      
      setAnalyzeSuccess(true);
    } catch (err) {
      console.error(err);
      setAnalyzeError(`AI 分析失敗 (${err.message})。請確認 API Key 是否正確。`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleVariantChange = (index, field, value) => {
    const newVariants = [...formData.variants];
    newVariants[index][field] = value;
    setFormData(prev => ({ ...prev, variants: newVariants }));
  };

  const addVariant = () => {
    setFormData(prev => ({ ...prev, variants: [...prev.variants, { style: '', costCny: '', limitCny: '', limitOverseasCny: '' }] }));
  };

  const removeVariant = (index) => {
    setFormData(prev => ({ ...prev, variants: prev.variants.filter((_, i) => i !== index) }));
  };

  const saveToDatabase = async () => {
    if (!formData.productName || formData.variants.length === 0) {
      setAnalyzeError("請至少填寫商品名稱與一個款式售價！");
      return;
    }
    if (!user || !db) {
      setAnalyzeError("請先至「⚙️ 設定」分頁配置 Firebase 雲端資料庫！");
      return;
    }

    const newId = Date.now().toString();
    const newItem = {
      ...formData,
      productImage: productImage || null,
      savedAt: new Date().toISOString()
    };

    try {
      const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'products', newId);
      await setDoc(docRef, newItem);
      
      setChatImage(null);
      setProductImage(null);
      setChatMimeType(null);
      setFormData({
        productName: '',
        chatTime: '',
        sizes: '',
        cutoffTime: '',
        exchangeRate: 4.9,
        sellMultiplier: 4.6,
        fullChatText: '',
        variants: [{ style: '', costCny: '', limitCny: '', limitOverseasCny: '' }]
      });
      setAnalyzeSuccess(false);
      
      setActiveTab('database');
    } catch (error) {
      console.error("Save error:", error);
      setAnalyzeError(`儲存失敗: ${error.message}。請確認 Firebase 設定與權限。`);
    }
  };

  const deleteItem = async (id) => {
    if (!user || !db) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'products', id));
    } catch (error) {
      console.error("Delete error:", error);
    }
  };

  const filteredDatabase = database.filter(item => {
    const searchLower = searchTerm.toLowerCase();
    const productName = item.productName || '';
    const chatText = item.fullChatText || '';
    return productName.toLowerCase().includes(searchLower) || chatText.toLowerCase().includes(searchLower);
  });

  const exportToCSV = () => {
    if (database.length === 0) return;
    
    const BOM = '\uFEFF';
    let csvContent = BOM + "建檔日期,商品名稱,尺寸,時效,截單時間,成本匯率,建議售價乘數,款式與價格細節,廠商完整對話\n";

    filteredDatabase.forEach(item => {
      const date = new Date(item.savedAt).toLocaleDateString();
      const name = `"${(item.productName || '').replace(/"/g, '""')}"`;
      const sizes = `"${(item.sizes || '').replace(/"/g, '""')}"`;
      const chatTime = `"${(item.chatTime || '').replace(/"/g, '""')}"`;
      const cutoff = `"${(item.cutoffTime || '').replace(/"/g, '""')}"`;
      const rate = item.exchangeRate || 4.9;
      const multi = item.sellMultiplier || 4.6;
      const text = `"${(item.fullChatText || '').replace(/"/g, '""')}"`;

      let variantsText = item.variants?.map(v => {
        const costTwd = v.costCny ? Math.ceil(v.costCny * rate) : 0;
        const limitTwd = v.limitCny ? Math.ceil(v.limitCny * multi) : 0;
        return `[${v.style || '預設'}] 拿¥${v.costCny}->本NT$${costTwd} / 賣NT$${limitTwd}`;
      }).join(' | ') || '';
      variantsText = `"${variantsText.replace(/"/g, '""')}"`;

      csvContent += `${date},${name},${sizes},${chatTime},${cutoff},${rate},${multi},${variantsText},${text}\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `商品庫備份_${new Date().toLocaleDateString()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // 儲存設定
  const saveSettings = () => {
    localStorage.setItem('custom_gemini_api_key', geminiKeyInput.trim());
    if (firebaseConfigInput.trim()) {
      try {
        JSON.parse(firebaseConfigInput);
        localStorage.setItem('custom_firebase_config', firebaseConfigInput.trim());
      } catch (e) {
        alert("Firebase 設定格式錯誤，請確認貼上的是 JSON 格式，例如 { \"apiKey\": \"...\" }");
        return;
      }
    } else {
      localStorage.removeItem('custom_firebase_config');
    }
    
    alert("設定已儲存！系統即將重新載入以套用設定。");
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans pb-20 sm:pb-0">
      {/* Motivation Header */}
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white p-4 shadow-md">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <Home className="w-6 h-6 text-yellow-300" />
            <h1 className="text-lg font-bold">為自由的房子努力！每天 5 分鐘上架計畫</h1>
          </div>
          <p className="text-sm text-indigo-100 mt-2 sm:mt-0 font-medium tracking-wide">
            距離月入 20 萬的夢想，又近了一件商品。不要懶，動起來！
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto p-4 sm:p-6 mt-4">
        
        {/* Navigation Tabs */}
        <div className="flex space-x-1 bg-slate-200/50 p-1 rounded-xl mb-6">
          <button
            onClick={() => setActiveTab('upload')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
              activeTab === 'upload' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
            }`}
          >
            <PlusCircle className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="hidden sm:inline">新增上架 (AI 分析)</span>
            <span className="sm:hidden">新增</span>
          </button>
          <button
            onClick={() => setActiveTab('database')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
              activeTab === 'database' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
            }`}
          >
            {isSyncing ? <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 animate-spin text-slate-400" /> : <Cloud className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-500" />}
            <span className="hidden sm:inline">雲端商品庫 ({database.length})</span>
            <span className="sm:hidden">商品庫</span>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
              activeTab === 'settings' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Settings className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="hidden sm:inline">系統設定</span>
            <span className="sm:hidden">設定</span>
          </button>
        </div>

        {/* --- UPLOAD & AI TAB --- */}
        {activeTab === 'upload' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* Left Column: Image Uploads */}
            <div className="space-y-6">
              {/* Image 1: Chat Screenshot */}
              <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
                <div className="flex items-center gap-2 mb-3">
                  <MessageSquare className="w-5 h-5 text-indigo-500" />
                  <h2 className="font-bold text-lg text-slate-700">第一張：廠商對話截圖</h2>
                </div>
                <p className="text-xs text-slate-500 mb-4">包含對話時間(建檔時效)、成本、限價等資訊。</p>
                
                <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-indigo-200 border-dashed rounded-xl cursor-pointer bg-indigo-50 hover:bg-indigo-100 transition-colors relative overflow-hidden">
                  {chatImage ? (
                    <img src={chatImage} alt="Chat preview" className="absolute inset-0 w-full h-full object-contain bg-black/5" />
                  ) : (
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <Upload className="w-8 h-8 text-indigo-400 mb-2" />
                      <p className="text-sm text-indigo-600 font-medium">點擊或拖曳上傳對話截圖</p>
                    </div>
                  )}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'chat')} />
                </label>
              </div>

              {/* Image 2: Product Image */}
              <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
                <div className="flex items-center gap-2 mb-3">
                  <ImageIcon className="w-5 h-5 text-pink-500" />
                  <h2 className="font-bold text-lg text-slate-700">第二張：產品圖片</h2>
                </div>
                <p className="text-xs text-slate-500 mb-4">這是用來展示給客人看，以及顯示在後台的縮圖。</p>
                
                <label className="flex flex-col items-center justify-center w-full h-40 border-2 border-pink-200 border-dashed rounded-xl cursor-pointer bg-pink-50 hover:bg-pink-100 transition-colors relative overflow-hidden">
                  {productImage ? (
                    <img src={productImage} alt="Product preview" className="absolute inset-0 w-full h-full object-contain bg-black/5" />
                  ) : (
                    <div className="flex flex-col items-center justify-center pt-5 pb-6">
                      <Upload className="w-8 h-8 text-pink-400 mb-2" />
                      <p className="text-sm text-pink-600 font-medium">點擊或拖曳上傳產品圖</p>
                    </div>
                  )}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'product')} />
                </label>
              </div>
            </div>

            {/* Right Column: AI Analysis & Form */}
            <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-lg text-slate-700">AI 資料擷取與定價</h2>
                <button 
                  onClick={analyzeChatImage}
                  disabled={!chatImage || isAnalyzing}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                    !chatImage ? 'bg-slate-100 text-slate-400 cursor-not-allowed' :
                    isAnalyzing ? 'bg-indigo-100 text-indigo-500 cursor-wait' :
                    'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md hover:shadow-lg'
                  }`}
                >
                  {isAnalyzing ? (
                    <><RefreshCw className="w-4 h-4 animate-spin" /> 分析中...</>
                  ) : (
                    <>🚀 開始 AI 分析</>
                  )}
                </button>
              </div>

              {analyzeError && (
                <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg mb-4 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {analyzeError}
                </div>
              )}

              {analyzeSuccess && (
                <div className="flex items-center gap-2 text-green-600 bg-green-50 p-3 rounded-lg mb-4 text-sm">
                  <CheckCircle className="w-4 h-4 shrink-0" />
                  AI 分析完成！請確認或微調以下數值。
                </div>
              )}

              {/* Form Fields */}
              <div className="space-y-4 flex-1">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1">商品名稱</label>
                  <input 
                    type="text" name="productName" value={formData.productName} onChange={handleInputChange}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                    placeholder="例如: 韓國保濕精華液 (不含款式描述)"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">建檔時效</label>
                    <input 
                      type="text" name="chatTime" value={formData.chatTime} onChange={handleInputChange}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      placeholder="例: 4/19-08"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">截單時間</label>
                    <input 
                      type="text" name="cutoffTime" value={formData.cutoffTime} onChange={handleInputChange}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder="例: 一個月後出"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">尺寸範圍</label>
                    <input 
                      type="text" name="sizes" value={formData.sizes} onChange={handleInputChange}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder="例: 80-140"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">成本匯率</label>
                      <input 
                        type="number" step="0.01" name="exchangeRate" value={formData.exchangeRate} onChange={handleInputChange}
                        className="w-full px-2 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none bg-blue-50 font-bold text-blue-700 text-sm"
                        placeholder="4.9"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">售價乘數 (限價x)</label>
                      <input 
                        type="number" step="0.01" name="sellMultiplier" value={formData.sellMultiplier} onChange={handleInputChange}
                        className="w-full px-2 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none bg-indigo-50 font-bold text-indigo-700 text-sm"
                        placeholder="4.6"
                      />
                    </div>
                  </div>
                </div>

                <div className="pt-2 mt-2 border-t border-slate-100">
                  <div className="flex items-center justify-between mb-3">
                    <label className="block text-sm font-bold text-indigo-700">款式與價格設定</label>
                    <button type="button" onClick={addVariant} className="text-xs flex items-center gap-1 text-indigo-600 hover:text-indigo-800 bg-indigo-50 px-2 py-1 rounded-md">
                      <PlusCircle className="w-3 h-3" /> 新增款式
                    </button>
                  </div>

                  <div className="max-h-[300px] overflow-y-auto pr-2 space-y-3">
                    {formData.variants.map((v, i) => {
                      const costTwd = v.costCny ? Math.ceil(v.costCny * formData.exchangeRate) : 0;
                      const sellMulti = formData.sellMultiplier || 4.6;
                      const limitTwd = v.limitCny ? Math.ceil(v.limitCny * sellMulti) : null;
                      const limitOverseasTwd = v.limitOverseasCny ? Math.ceil(v.limitOverseasCny * sellMulti) : null;

                      return (
                        <div key={i} className="p-3 border-2 border-slate-100 rounded-xl bg-white relative shadow-sm">
                          {formData.variants.length > 1 && (
                            <button type="button" onClick={() => removeVariant(i)} className="absolute -top-2 -right-2 bg-red-100 text-red-500 hover:bg-red-500 hover:text-white rounded-full p-1 shadow-sm transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                          <div className="grid grid-cols-4 gap-2 mb-2">
                            <div>
                              <label className="text-[10px] text-slate-500 block mb-1">款式名稱</label>
                              <input type="text" value={v.style} onChange={e => handleVariantChange(i, 'style', e.target.value)} placeholder="A1,A2" className="w-full px-2 py-1 text-sm border rounded" />
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 block mb-1">拿貨價(CNY)</label>
                              <input type="number" value={v.costCny} onChange={e => handleVariantChange(i, 'costCny', e.target.value)} placeholder="¥0" className="w-full px-2 py-1 text-sm border rounded" />
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 block mb-1">國內限價</label>
                              <input type="number" value={v.limitCny} onChange={e => handleVariantChange(i, 'limitCny', e.target.value)} placeholder="無則空" className="w-full px-2 py-1 text-sm border rounded" />
                            </div>
                            <div>
                              <label className="text-[10px] text-slate-500 block mb-1">海外限價</label>
                              <input type="number" value={v.limitOverseasCny} onChange={e => handleVariantChange(i, 'limitOverseasCny', e.target.value)} placeholder="+10" className="w-full px-2 py-1 text-sm border rounded" />
                            </div>
                          </div>
                          <div className="flex justify-between items-center text-xs font-semibold bg-indigo-50 p-2 rounded-lg border border-indigo-100">
                            <span className="text-slate-600">成本: NT${costTwd}</span>
                            <div className="flex gap-4">
                              <span className="text-indigo-700 text-sm">國內賣: <span className="text-base">NT${limitTwd || 0}</span></span>
                              <span className="text-pink-600 text-sm">海外賣: <span className="text-base">NT${limitOverseasTwd || 0}</span></span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 mt-2">
                  <label className="block text-xs font-semibold text-slate-500 mb-1">廠商對話完整原文</label>
                  <textarea 
                    name="fullChatText" value={formData.fullChatText} onChange={handleInputChange}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-xs text-slate-600 h-24"
                    placeholder="AI 會將廠商的對話一字不漏轉錄在此，方便後續核對"
                  />
                </div>
              </div>

              {/* Save Button */}
              <button 
                onClick={saveToDatabase}
                className="w-full mt-6 py-4 bg-slate-900 text-white rounded-xl font-bold text-lg hover:bg-slate-800 shadow-lg flex items-center justify-center gap-2 transition-transform active:scale-[0.98]"
              >
                <Save className="w-5 h-5" />
                儲存至後台，完成今日進度！
              </button>
            </div>
          </div>
        )}

        {/* --- DATABASE TAB --- */}
        {activeTab === 'database' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50">
              <div>
                <h2 className="font-bold text-lg text-slate-700">商品庫 (目前顯示 {filteredDatabase.length} 筆)</h2>
                <p className="text-xs text-slate-500 mt-1">這些是你努力的成果，快把他們上架到賣場吧！</p>
                {!db && <p className="text-xs font-bold text-red-500 mt-2">⚠️ 尚未連結雲端資料庫，請至「設定」配置 Firebase</p>}
              </div>
              
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <div className="relative flex-1 sm:w-64">
                  <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
                  <input 
                    type="text" 
                    placeholder="搜尋名稱或對話內容..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <button 
                  onClick={exportToCSV}
                  className="flex items-center gap-2 px-3 py-2 bg-green-50 text-green-600 hover:bg-green-100 hover:text-green-700 rounded-lg text-sm font-bold transition-colors whitespace-nowrap"
                  title="下載為 Excel (CSV) 檔案"
                >
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">備份資料</span>
                </button>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              {filteredDatabase.length === 0 ? (
                <div className="p-12 text-center flex flex-col items-center">
                  <Database className="w-16 h-16 text-slate-200 mb-4" />
                  <p className="text-slate-500 font-medium">{searchTerm ? '找不到符合關鍵字的商品' : '目前還沒有建檔的商品喔'}</p>
                  {!searchTerm && (
                    <button 
                      onClick={() => setActiveTab('upload')}
                      className="mt-4 px-6 py-2 bg-indigo-50 text-indigo-600 rounded-lg font-semibold hover:bg-indigo-100 transition-colors"
                    >
                      去新增第一個商品
                    </button>
                  )}
                </div>
              ) : (
                <table className="w-full text-left border-collapse min-w-[1000px]">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500 text-sm border-b border-slate-100">
                      <th className="p-4 font-semibold w-20">圖片</th>
                      <th className="p-4 font-semibold w-48">商品資訊</th>
                      <th className="p-4 font-semibold">款式 / 成本 / 建議售價</th>
                      <th className="p-4 font-semibold w-64">完整對話紀錄</th>
                      <th className="p-4 font-semibold text-center w-16">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredDatabase.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50/80 transition-colors group">
                        <td className="p-4 align-top">
                          <div className="w-16 h-16 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center">
                            {item.productImage ? (
                              <img src={item.productImage} alt={item.productName} className="w-full h-full object-cover" />
                            ) : (
                              <ImageIcon className="w-6 h-6 text-slate-300" />
                            )}
                          </div>
                        </td>
                        <td className="p-4 align-top">
                          <p className="font-bold text-slate-700">{item.productName}</p>
                          <div className="flex flex-wrap gap-1 mt-2">
                            <span className="inline-block px-2 py-1 bg-blue-50 text-blue-600 text-xs rounded-md border border-blue-100">
                              時效: {item.chatTime || '未紀錄'}
                            </span>
                            {item.sizes && (
                              <span className="inline-block px-2 py-1 bg-purple-50 text-purple-600 text-xs rounded-md border border-purple-100">
                                尺寸: {item.sizes}
                              </span>
                            )}
                            {item.cutoffTime && (
                              <span className="inline-block px-2 py-1 bg-orange-50 text-orange-600 text-xs rounded-md border border-orange-100">
                                截單: {item.cutoffTime}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-slate-400 mt-2">建檔: {new Date(item.savedAt).toLocaleDateString()}</p>
                        </td>
                        <td className="p-4 align-top">
                          <div className="space-y-2">
                            {item.variants && item.variants.map((v, i) => {
                              const costTwd = v.costCny ? Math.ceil(v.costCny * (item.exchangeRate || 4.9)) : 0;
                              const sellMulti = item.sellMultiplier || 4.6;
                              const limitTwd = v.limitCny ? Math.ceil(v.limitCny * sellMulti) : null;
                              const limitOverseasTwd = v.limitOverseasCny ? Math.ceil(v.limitOverseasCny * sellMulti) : null;
                              
                              return (
                                <div key={i} className="text-sm flex flex-col gap-1 pb-2 border-b border-slate-100 last:border-0 last:pb-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-slate-700 min-w-[40px]">{v.style || '預設'}</span>
                                    <span className="text-slate-500 bg-slate-100 px-1 rounded text-xs">拿 ¥{v.costCny} <span className="text-[10px]">({item.exchangeRate || 4.9})</span> ➜ 本 NT${costTwd}</span>
                                  </div>
                                  <div className="flex items-center gap-2 pl-[48px]">
                                    {limitTwd && <span className="font-bold text-indigo-600">國內 NT${limitTwd}</span>}
                                    {limitOverseasTwd && <span className="font-bold text-pink-600 ml-2">海外 NT${limitOverseasTwd}</span>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </td>
                        <td className="p-4 align-top">
                          <div className="text-xs text-slate-600 bg-slate-100/50 border border-slate-200 p-2 rounded-lg whitespace-pre-wrap max-h-28 overflow-y-auto w-full">
                            {item.fullChatText || '無對話紀錄'}
                          </div>
                        </td>
                        <td className="p-4 align-top text-center">
                          <button 
                            onClick={() => deleteItem(item.id)}
                            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors mt-1"
                            title="刪除"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* --- SETTINGS TAB --- */}
        {activeTab === 'settings' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden max-w-2xl mx-auto">
            <div className="p-5 border-b border-slate-100 bg-slate-50/50">
              <h2 className="font-bold text-lg text-slate-700 flex items-center gap-2"><Settings className="w-5 h-5 text-slate-500"/> 系統引擎設定</h2>
              <p className="text-xs text-slate-500 mt-1">在這裡輸入你的專屬金鑰，讓小幫手擁有大腦和雲端保險箱。這段設定只會存在你的瀏覽器中，非常安全。</p>
            </div>
            
            <div className="p-6 space-y-8">
              {/* Gemini API Key */}
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">1. AI 引擎鑰匙 (Gemini API Key)</label>
                <input 
                  type="password" 
                  value={geminiKeyInput} 
                  onChange={(e) => setGeminiKeyInput(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-sm"
                  placeholder="AIzaSy..."
                />
                <p className="text-xs text-slate-500 mt-2">
                  前往 <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline font-semibold">Google AI Studio</a> 建立免費的 API Key 並貼在這裡。
                </p>
              </div>

              <hr className="border-slate-100" />

              {/* Firebase Config */}
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">2. 雲端保險箱設定 (Firebase Config)</label>
                <textarea 
                  value={firebaseConfigInput} 
                  onChange={(e) => setFirebaseConfigInput(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-xs h-40"
                  placeholder={`{\n  "apiKey": "...",\n  "authDomain": "...",\n  "projectId": "...",\n  "storageBucket": "...",\n  "messagingSenderId": "...",\n  "appId": "..."\n}`}
                />
                <div className="text-xs text-slate-500 mt-2 space-y-1">
                  <p>前往 <a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline font-semibold">Firebase</a> 建立專案與 Web 應用程式。</p>
                  <p className="text-red-500 font-semibold">⚠️ 必做事項：</p>
                  <ul className="list-disc pl-5">
                    <li>複製系統提供的那段 JSON 設定碼貼在這裡 (只要大括號的部分)。</li>
                    <li>在 Firebase 後台的 Authentication (驗證) 中，啟用 <strong>Anonymous (匿名)</strong> 登入。</li>
                    <li>在 Firestore Database 中建立資料庫，並選擇 <strong>以測試模式開始 (Test Mode)</strong>。</li>
                  </ul>
                </div>
              </div>

              {/* Save Button */}
              <button 
                onClick={saveSettings}
                className="w-full py-3 bg-indigo-600 text-white rounded-xl font-bold text-md hover:bg-indigo-700 shadow-md transition-colors"
              >
                儲存設定並重啟系統
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
