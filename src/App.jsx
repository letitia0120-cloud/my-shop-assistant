import React, { useState, useRef, useEffect } from 'react';
import { Upload, Image as ImageIcon, MessageSquare, Database, PlusCircle, Save, Trash2, RefreshCw, CheckCircle, AlertCircle, Home, Cloud, Search, Download, Settings, LogIn, LogOut, Timer, Type, Calculator, Store, Edit } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';

// API Retry Utility - v3.7 升級：移除焦慮秒數，保留背景排隊機制
const fetchWithRetry = async (url, options, retries = 5, onRetry) => {
  // 稍微縮短排隊等待時間，避免等太久讓使用者覺得卡住
  const delays = [2000, 4000, 8000, 10000, 15000];
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        let errText = '';
        try {
          const errJson = await response.json();
          errText = errJson.error?.message || response.statusText;
        } catch (e) {
          errText = response.statusText;
        }
        const error = new Error(`${response.status} - ${errText}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (e) {
      // 遇到 400(參數錯), 403(沒權限), 404(找不到) 代表真的錯了，直接拋出不重試
      if (e.status === 400 || e.status === 403 || e.status === 404) throw e;
      
      // 如果已經是最後一次重試，就放棄並把錯誤丟給畫面顯示
      if (i === retries - 1) throw e;

      // 決定要等多久
      let waitTime = delays[i];
      if (e.status === 429 && e.message) {
        const match = e.message.match(/retry in (\d+(\.\d+)?)s/);
        if (match) {
          waitTime = Math.ceil(parseFloat(match[1])) * 1000 + 500; 
        }
      }
      
      // 通知畫面正在進行第幾次重試 (但不回傳秒數)
      if (onRetry) onRetry(i + 1);
      
      // 靜靜地在背景等待，不顯示秒數干擾心情
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
};

// --- Firebase Initialization ---
let app, auth, db, appId = 'my-shop-assistant';

try {
  let configObj = null;
  const customConfig = localStorage.getItem('custom_firebase_config');
  
  if (typeof __firebase_config !== 'undefined' && __firebase_config) {
    configObj = JSON.parse(__firebase_config);
    appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
  } else if (customConfig) {
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
  const [activeTab, setActiveTab] = useState('upload'); 
  
  const [pasteText, setPasteText] = useState(''); 
  const [chatImage, setChatImage] = useState(null);
  const [chatMimeType, setChatMimeType] = useState(null);
  const [productImage, setProductImage] = useState(null);
  
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);
  const [analyzeSuccess, setAnalyzeSuccess] = useState(false);
  
  const [retryCount, setRetryCount] = useState(0); 
  const [editingId, setEditingId] = useState(null); // 新增：紀錄正在編輯的商品 ID
  
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

  // --- 快速試算狀態 ---
  const [calcState, setCalcState] = useState({
    costCny: '',
    exchangeRate: 4.9,
    limitCny: '',
    limitOverseasCny: '',
    sellMultiplier: 4.6
  });

  // --- 蝦皮毛利試算狀態 (移除預設手續費) ---
  const [shopeeCalc, setShopeeCalc] = useState({
    sellNtd: '',
    costNtd: '',
    feeRate: ''
  });

  // --- 新增：蝦皮反算狀態 ---
  const [reverseCalc, setReverseCalc] = useState({
    costNtd: '',
    targetMargin: '',
    feeRate: ''
  });

  const [database, setDatabase] = useState([]);
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [isSyncing, setIsSyncing] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const [geminiKeyInput, setGeminiKeyInput] = useState(localStorage.getItem('custom_gemini_api_key') || '');
  const [firebaseConfigInput, setFirebaseConfigInput] = useState(localStorage.getItem('custom_firebase_config') || '');
  const [modelInput, setModelInput] = useState(localStorage.getItem('custom_gemini_model') || 'gemini-2.5-flash');

  // --- Firebase Auth Setup ---
  useEffect(() => {
    if (!auth) {
      setIsSyncing(false);
      return;
    }
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        setAuthError(null);
      } else {
        setDatabase([]); 
      }
    });
    return () => unsubscribe();
  }, []);

  const login = async () => {
    if (!auth) {
      alert("請先完成系統設定中的 Firebase 配置！");
      setActiveTab('settings');
      return;
    }
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login error:", error);
      setAuthError(error.message);
      alert("登入失敗：" + error.message);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setAnalyzeError(null);
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

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
          setAnalyzeError(null); 
        }
      } else if (type === 'product') {
        compressImage(dataUrl, (compressedUrl) => {
          setProductImage(compressedUrl);
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const analyzeData = async () => {
    if (!chatImage && !pasteText.trim()) {
      setAnalyzeError("請貼上廠商文字，或上傳廠商對話截圖！");
      return;
    }

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
    setRetryCount(0); 

    try {
      const customModel = localStorage.getItem('custom_gemini_model') || 'gemini-2.5-flash';
      const modelName = (isCanvasEnv && !customApiKey) ? 'gemini-2.5-flash-preview-09-2025' : customModel;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      
      const prompt = `這是一段廠商發佈的商品資訊（可能是文字、圖片截圖，或兩者皆有），請從中擷取商品上架所需的資訊。
      請盡可能找出：
      1. 建檔時效 (對話時間)：請格式化為「月/日-小時」，例如截圖中的手機時間08:14，今天是4/19，請寫成 "4/19-08"。若無明確時間可留空或依文字推斷。
      2. 提到的商品名稱：請簡短扼要（例如 "Minecraft 新款童裝"），**絕對不要**包含具體的款式名稱（請把「半袖」、「褲子」從主名稱中去掉）。
      3. 尺寸範圍 (例如 "80-140")
      4. 截單時間 (例如 "截單後一個多月出")
      5. 款式與價格清單 (variants)：請列出所有提到的款式群組，以及對應的拿貨價(costCny)、限價(limitCny)與限價+海外(limitOverseasCny)。例如寫「限價48¥/58¥」，則 limitCny=48，limitOverseasCny=58。若只提供一個限價數字，limitOverseasCny 預設為該限價+10。請分開不同價位的群組。
      6. 完整廠商對話原文：請將截圖中或我提供的文字內容，完整、一字不漏地轉錄。
      如果找不到特定資訊，請留空或回傳 null。`;

      const parts = [{ text: prompt }];

      if (pasteText.trim()) {
        parts[0].text += `\n\n【廠商提供的文字內容如下】：\n${pasteText}`;
      }

      if (chatImage && chatMimeType) {
        const base64Data = chatImage.split(',')[1];
        parts.push({ inlineData: { mimeType: chatMimeType, data: base64Data } });
      }

      const payload = {
        contents: [{ role: "user", parts: parts }],
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
      }, 5, 
      (attempt) => { setRetryCount(attempt); } 
      );

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
      setAnalyzeError(`AI 伺服器目前極度繁忙，連續嘗試失敗。請稍後再試或考慮綁定信用卡升級。 (${err.message})`);
    } finally {
      setIsAnalyzing(false);
      setRetryCount(0); 
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
    
    if (!db) {
      setAnalyzeError("Firebase 資料庫未連接。請至「⚙️ 設定」分頁確認設定碼是否正確。");
      return;
    }

    if (!user) {
      setAnalyzeError(`請先點擊上方「登入雲端同步」，登入 Google 帳號後才能存檔喔！`);
      return;
    }

    const targetId = editingId || Date.now().toString(); // 編輯模式用舊ID，新增模式用新ID
    const originalSavedAt = editingId ? database.find(item => item.id === editingId)?.savedAt : null;

    const newItem = {
      ...formData,
      productImage: productImage || null,
      savedAt: originalSavedAt || new Date().toISOString()
    };

    try {
      const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'products', targetId);
      await setDoc(docRef, newItem);
      
      setChatImage(null);
      setPasteText(''); 
      setProductImage(null);
      setChatMimeType(null);
      setEditingId(null); // 存檔後清除編輯狀態
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
      setAnalyzeError(null);
      
      setActiveTab('database');
    } catch (error) {
      console.error("Save error:", error);
      setAnalyzeError(`儲存失敗: ${error.message}。請確認 Firestore 是否已設定為測試模式。`);
    }
  };

  // 新增：取消編輯功能
  const cancelEdit = () => {
    setEditingId(null);
    setChatImage(null);
    setPasteText(''); 
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
    setActiveTab('database');
  };

  // 新增：載入編輯資料功能
  const handleEdit = (item) => {
    setFormData({
      productName: item.productName || '',
      chatTime: item.chatTime || '',
      sizes: item.sizes || '',
      cutoffTime: item.cutoffTime || '',
      exchangeRate: item.exchangeRate || 4.9,
      sellMultiplier: item.sellMultiplier || 4.6,
      fullChatText: item.fullChatText || '',
      variants: item.variants && item.variants.length > 0 ? item.variants : [{ style: '', costCny: '', limitCny: '', limitOverseasCny: '' }]
    });
    setProductImage(item.productImage || null);
    setEditingId(item.id);
    setActiveTab('upload');
    window.scrollTo({ top: 0, behavior: 'smooth' }); // 自動捲動到最上方
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

  const saveSettings = () => {
    localStorage.setItem('custom_gemini_api_key', geminiKeyInput.trim());
    localStorage.setItem('custom_gemini_model', modelInput.trim());
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
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white p-4 shadow-md sticky top-0 z-50">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between">
          <div className="flex items-center gap-3">
            <Home className="w-6 h-6 text-yellow-300" />
            <h1 className="text-lg font-bold">雙兔幼幼園 (v3.8 專屬試算版)</h1>
          </div>
          
          <div className="flex items-center gap-3 mt-3 sm:mt-0">
            {user ? (
              <div className="flex items-center gap-3 bg-white/10 px-3 py-1.5 rounded-full border border-white/20 shadow-sm">
                <div className="flex flex-col items-end">
                  <span className="text-[10px] text-indigo-100 uppercase tracking-wider font-bold">雲端已連線</span>
                  <span className="text-sm font-bold truncate max-w-[120px]">{user.displayName || '老闆娘'}</span>
                </div>
                <div className="w-px h-6 bg-white/20 mx-1"></div>
                <button onClick={logout} className="p-1.5 hover:bg-white/20 rounded-full transition-colors flex items-center gap-1" title="登出">
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button onClick={login} className="flex items-center gap-2 bg-yellow-400 hover:bg-yellow-300 text-indigo-900 px-4 py-2 rounded-full font-bold transition-all shadow-md active:scale-95 text-sm">
                <LogIn className="w-4 h-4" /> 點我登入雲端同步
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-4 sm:p-6 mt-2">
        <div className="flex space-x-1 bg-slate-200/50 p-1 rounded-xl mb-6 overflow-x-auto">
          <button
            onClick={() => { setActiveTab('upload'); if(activeTab !== 'upload') setEditingId(null); }}
            className={`flex-1 min-w-[90px] flex items-center justify-center gap-1 sm:gap-2 py-3 px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
              activeTab === 'upload' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
            }`}
          >
            <PlusCircle className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="hidden sm:inline">{editingId ? '編輯商品' : '新增上架'}</span>
            <span className="sm:hidden">{editingId ? '編輯' : '上架'}</span>
          </button>
          
          {/* 新增的快速試算分頁按鈕 */}
          <button
            onClick={() => setActiveTab('calculator')}
            className={`flex-1 min-w-[90px] flex items-center justify-center gap-1 sm:gap-2 py-3 px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
              activeTab === 'calculator' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Calculator className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="hidden sm:inline">快速試算</span>
            <span className="sm:hidden">試算</span>
          </button>

          <button
            onClick={() => setActiveTab('database')}
            className={`flex-1 min-w-[90px] flex items-center justify-center gap-1 sm:gap-2 py-3 px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
              activeTab === 'database' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
            }`}
          >
            {isSyncing ? <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 animate-spin text-slate-400" /> : <Cloud className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-500" />}
            <span className="hidden sm:inline">商品庫 ({database.length})</span>
            <span className="sm:hidden">商品庫</span>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex-1 min-w-[90px] flex items-center justify-center gap-1 sm:gap-2 py-3 px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-semibold transition-all whitespace-nowrap ${
              activeTab === 'settings' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Settings className="w-4 h-4 sm:w-5 sm:h-5" />
            <span className="hidden sm:inline">系統設定</span>
            <span className="sm:hidden">設定</span>
          </button>
        </div>

        {/* --- 新增的 快速試算 分頁內容 --- */}
        {activeTab === 'calculator' && (
          <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* 左側：人民幣批價與售價試算 */}
            <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-sm border border-slate-100">
              <div className="flex items-center gap-3 mb-6 border-b border-slate-100 pb-4">
                <div className="bg-indigo-100 p-3 rounded-xl">
                  <Calculator className="w-6 h-6 text-indigo-600" />
                </div>
                <div>
                  <h2 className="font-bold text-xl text-slate-700">利潤與售價快速試算</h2>
                  <p className="text-xs text-slate-500 mt-1">無需建檔，快速換算廠商報價，精準掌握利潤。</p>
                </div>
              </div>

              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-bold text-slate-600 mb-2">成本匯率</label>
                    <input 
                      type="number" step="0.01" 
                      value={calcState.exchangeRate} 
                      onChange={(e) => setCalcState({...calcState, exchangeRate: parseFloat(e.target.value) || 0})}
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none bg-blue-50 font-bold text-blue-700 text-lg transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-slate-600 mb-2">限價乘數 (賣價倍數)</label>
                    <input 
                      type="number" step="0.01" 
                      value={calcState.sellMultiplier} 
                      onChange={(e) => setCalcState({...calcState, sellMultiplier: parseFloat(e.target.value) || 0})}
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none bg-indigo-50 font-bold text-indigo-700 text-lg transition-all"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-slate-50 p-6 rounded-2xl border border-slate-100">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-bold text-slate-600 mb-2">廠商拿貨價 (¥)</label>
                      <input 
                        type="number" 
                        value={calcState.costCny} 
                        onChange={(e) => setCalcState({...calcState, costCny: e.target.value})}
                        className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-lg transition-all shadow-sm"
                        placeholder="請輸入成本..."
                      />
                    </div>
                    <div className="bg-blue-100/50 p-4 rounded-xl border border-blue-200">
                      <span className="block text-xs font-bold text-blue-600 mb-1">實際台幣成本 (無條件進位)</span>
                      <span className="text-3xl font-black text-blue-800">
                        NT$ {calcState.costCny ? Math.ceil(parseFloat(calcState.costCny) * calcState.exchangeRate) : '0'}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-bold text-slate-600 mb-2">國內限價 (¥)</label>
                      <input 
                        type="number" 
                        value={calcState.limitCny} 
                        onChange={(e) => setCalcState({...calcState, limitCny: e.target.value})}
                        className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-lg transition-all shadow-sm"
                        placeholder="國內限價..."
                      />
                    </div>
                    <div className="bg-indigo-100/50 p-4 rounded-xl border border-indigo-200">
                      <span className="block text-xs font-bold text-indigo-600 mb-1">國內台幣售價 (無條件進位)</span>
                      <span className="text-3xl font-black text-indigo-800">
                        NT$ {calcState.limitCny ? Math.ceil(parseFloat(calcState.limitCny) * calcState.sellMultiplier) : '0'}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-bold text-slate-600 mb-2">海外限價 (¥)</label>
                      <input 
                        type="number" 
                        value={calcState.limitOverseasCny} 
                        onChange={(e) => setCalcState({...calcState, limitOverseasCny: e.target.value})}
                        className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-pink-500 outline-none text-lg transition-all shadow-sm"
                        placeholder="海外限價..."
                      />
                    </div>
                    <div className="bg-pink-100/50 p-4 rounded-xl border border-pink-200">
                      <span className="block text-xs font-bold text-pink-600 mb-1">海外台幣售價 (無條件進位)</span>
                      <span className="text-3xl font-black text-pink-800">
                        NT$ {calcState.limitOverseasCny ? Math.ceil(parseFloat(calcState.limitOverseasCny) * calcState.sellMultiplier) : '0'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 顯示預估毛利 */}
                {calcState.costCny && (calcState.limitCny || calcState.limitOverseasCny) && (
                  <div className="bg-green-50 p-4 rounded-xl border border-green-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                    <span className="font-bold text-green-700">單件預估毛利</span>
                    <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
                      {calcState.limitCny && (
                        <span className="text-xl font-black text-indigo-600">
                          國內: + NT$ {Math.ceil(parseFloat(calcState.limitCny) * calcState.sellMultiplier) - Math.ceil(parseFloat(calcState.costCny) * calcState.exchangeRate)}
                        </span>
                      )}
                      {calcState.limitOverseasCny && (
                        <span className="text-xl font-black text-pink-600">
                          海外: + NT$ {Math.ceil(parseFloat(calcState.limitOverseasCny) * calcState.sellMultiplier) - Math.ceil(parseFloat(calcState.costCny) * calcState.exchangeRate)}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                
                <button 
                  onClick={() => setCalcState({...calcState, costCny: '', limitCny: '', limitOverseasCny: ''})}
                  className="w-full py-3 text-sm font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  清除數字，計算下一件
                </button>
              </div>
            </div>

            {/* 右側：蝦皮專屬毛利率試算 & 反算 */}
            <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-sm border border-slate-100 flex flex-col gap-6">
              <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
                <div className="bg-orange-100 p-3 rounded-xl">
                  <Store className="w-6 h-6 text-orange-600" />
                </div>
                <div>
                  <h2 className="font-bold text-xl text-slate-700">蝦皮利潤 & 定價反算</h2>
                  <p className="text-xs text-slate-500 mt-1">扣除萬惡手續費，精準定價絕不虧錢。</p>
                </div>
              </div>

              {/* 模式一：算利潤 */}
              <div className="space-y-4">
                <div className="inline-block px-3 py-1 bg-slate-100 text-slate-600 text-xs font-bold rounded-lg mb-1">模式一：已知售價 ➜ 算利潤</div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-1">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">售價 (NT$)</label>
                    <input 
                      type="number" 
                      value={shopeeCalc.sellNtd} 
                      onChange={(e) => setShopeeCalc({...shopeeCalc, sellNtd: e.target.value})}
                      className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none text-sm transition-all shadow-sm"
                      placeholder="賣多少"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">成本 (NT$)</label>
                    <input 
                      type="number" 
                      value={shopeeCalc.costNtd} 
                      onChange={(e) => setShopeeCalc({...shopeeCalc, costNtd: e.target.value})}
                      className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none text-sm transition-all shadow-sm"
                      placeholder="成本"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">手續費率 (%)</label>
                    <input 
                      type="number" step="0.1" 
                      value={shopeeCalc.feeRate} 
                      onChange={(e) => setShopeeCalc({...shopeeCalc, feeRate: e.target.value})}
                      className="w-full px-2 py-2 border border-orange-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none bg-orange-50 font-bold text-orange-700 text-sm transition-all text-center"
                      placeholder="不預設"
                    />
                  </div>
                </div>

                {(() => {
                  const sell = parseFloat(shopeeCalc.sellNtd) || 0;
                  const cost = parseFloat(shopeeCalc.costNtd) || 0;
                  const feeRate = parseFloat(shopeeCalc.feeRate) || 0;
                  const fee = Math.round(sell * (feeRate / 100));
                  const netProfit = sell - cost - fee;
                  const margin = sell > 0 ? ((netProfit / sell) * 100).toFixed(1) : 0;
                  
                  return (
                    <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 space-y-3">
                      <div className="flex justify-between items-center pb-2 border-b border-slate-200">
                        <span className="text-slate-600 text-sm font-semibold flex items-center gap-1">實賺淨利潤</span>
                        <span className={`text-xl font-black ${netProfit > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                          {netProfit > 0 ? '+' : ''} NT$ {sell > 0 ? netProfit : '0'}
                        </span>
                      </div>
                      
                      <div className="flex justify-between items-center">
                        <span className="text-slate-600 text-sm font-bold">真實毛利率</span>
                        <div className="text-right">
                          <span className={`text-2xl font-black ${margin >= 20 ? 'text-orange-600' : (margin > 0 ? 'text-amber-500' : 'text-slate-400')}`}>
                            {sell > 0 ? `${margin}%` : '0%'}
                          </span>
                          {sell > 0 && <span className="block text-[10px] text-slate-400 mt-1">含手續費: NT${fee}</span>}
                        </div>
                      </div>
                    </div>
                  )
                })()}
              </div>

              <div className="border-t border-slate-100 my-1"></div>

              {/* 模式二：反算售價 */}
              <div className="space-y-4">
                <div className="inline-block px-3 py-1 bg-slate-100 text-slate-600 text-xs font-bold rounded-lg mb-1">模式二：定下毛利 ➜ 反算售價</div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-1">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">成本 (NT$)</label>
                    <input 
                      type="number" 
                      value={reverseCalc.costNtd} 
                      onChange={(e) => setReverseCalc({...reverseCalc, costNtd: e.target.value})}
                      className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-all shadow-sm"
                      placeholder="成本"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">目標毛利 (%)</label>
                    <input 
                      type="number" step="0.1" 
                      value={reverseCalc.targetMargin} 
                      onChange={(e) => setReverseCalc({...reverseCalc, targetMargin: e.target.value})}
                      className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-all shadow-sm"
                      placeholder="想賺幾%"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">手續費率 (%)</label>
                    <input 
                      type="number" step="0.1" 
                      value={reverseCalc.feeRate} 
                      onChange={(e) => setReverseCalc({...reverseCalc, feeRate: e.target.value})}
                      className="w-full px-2 py-2 border border-blue-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none bg-blue-50 font-bold text-blue-700 text-sm transition-all text-center"
                      placeholder="不預設"
                    />
                  </div>
                </div>

                {(() => {
                  const cost = parseFloat(reverseCalc.costNtd) || 0;
                  const targetMargin = (parseFloat(reverseCalc.targetMargin) || 0) / 100;
                  const feeRate = (parseFloat(reverseCalc.feeRate) || 0) / 100;
                  
                  let targetPrice = 0;
                  let fee = 0;
                  let netProfit = 0;

                  // 預防輸入毛利加手續費超過 100% 的不合理狀況
                  const denominator = 1 - targetMargin - feeRate;

                  if (cost > 0 && denominator > 0) {
                    targetPrice = Math.ceil(cost / denominator);
                    fee = Math.round(targetPrice * feeRate);
                    netProfit = targetPrice - cost - fee;
                  }

                  return (
                    <div className="bg-blue-50/50 p-4 rounded-2xl border border-blue-100 space-y-3 relative overflow-hidden">
                      {cost > 0 && denominator <= 0 && (
                        <div className="absolute inset-0 bg-red-100/90 flex flex-col items-center justify-center p-2 text-center backdrop-blur-sm z-10">
                          <span className="font-bold text-red-600 text-sm">目標不合理！</span>
                          <span className="text-xs text-red-500">毛利加上手續費不能等於或超過 100% 喔</span>
                        </div>
                      )}
                      <div className="flex justify-between items-center pb-2 border-b border-blue-100">
                        <span className="text-slate-600 text-sm font-semibold">蝦皮建議定價</span>
                        <span className={`text-2xl font-black ${targetPrice > 0 ? 'text-blue-700' : 'text-slate-400'}`}>
                          {targetPrice > 0 ? `NT$ ${targetPrice}` : '-'}
                        </span>
                      </div>
                      
                      <div className="flex justify-between items-center text-[11px] text-slate-500">
                        <span>預估抽成: NT$ {fee}</span>
                        <span className="font-bold text-green-600">預估淨利: + NT$ {netProfit}</span>
                      </div>
                    </div>
                  )
                })()}
              </div>
              
              <button 
                onClick={() => {
                  setShopeeCalc({sellNtd: '', costNtd: '', feeRate: ''});
                  setReverseCalc({costNtd: '', targetMargin: '', feeRate: ''});
                }}
                className="w-full py-3 mt-2 text-sm font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors"
              >
                清除所有數字，算下一件
              </button>
            </div>
          </div>
        )}

        {/* --- 原有的 Upload 分頁 --- */}
        {activeTab === 'upload' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-6">
              <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
                <div className="flex items-center gap-2 mb-3">
                  <Type className="w-5 h-5 text-indigo-500" />
                  <h2 className="font-bold text-lg text-slate-700">第一步：商品資訊</h2>
                </div>
                <p className="text-xs text-slate-500 mb-4 font-bold text-indigo-600 bg-indigo-50 p-2 rounded-lg border border-indigo-100">
                  💡 秘訣：直接貼上廠商文字（速度最快）！如果貼了文字，就【不用】上傳截圖囉！
                </p>
                
                <div className="mb-4">
                  <label className="block text-xs font-bold text-indigo-600 mb-1 flex items-center gap-1">
                    ⚡ 快速貼上文字分析區
                  </label>
                  <textarea
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    className="w-full px-3 py-2 border border-indigo-100 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none text-sm text-slate-700 h-24 bg-indigo-50/30 placeholder-slate-400 transition-all"
                    placeholder="請直接複製廠商群組的文字對話，貼在這裡..."
                  />
                </div>

                <div className="relative flex items-center py-2">
                  <div className="flex-grow border-t border-slate-100"></div>
                  <span className="flex-shrink-0 mx-4 text-slate-400 text-xs font-medium">或上傳對話截圖</span>
                  <div className="flex-grow border-t border-slate-100"></div>
                </div>

                <label className="flex flex-col items-center justify-center w-full h-24 border-2 border-indigo-100 border-dashed rounded-xl cursor-pointer hover:bg-indigo-50 transition-colors relative overflow-hidden mt-2">
                  {chatImage ? (
                    <img src={chatImage} alt="Chat preview" className="absolute inset-0 w-full h-full object-contain bg-black/5" />
                  ) : (
                    <div className="flex flex-col items-center justify-center pt-3 pb-4">
                      <Upload className="w-6 h-6 text-indigo-300 mb-1" />
                      <p className="text-xs text-indigo-500 font-medium">點擊或拖曳上傳截圖</p>
                    </div>
                  )}
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload(e, 'chat')} />
                </label>
              </div>

              <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
                <div className="flex items-center gap-2 mb-3">
                  <ImageIcon className="w-5 h-5 text-pink-500" />
                  <h2 className="font-bold text-lg text-slate-700">第二步：產品圖片</h2>
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

            <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-lg text-slate-700">AI 資料擷取與定價</h2>
                <button 
                  onClick={analyzeData}
                  disabled={(!chatImage && !pasteText.trim()) || isAnalyzing}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${
                    (!chatImage && !pasteText.trim()) ? 'bg-slate-100 text-slate-400 cursor-not-allowed' :
                    isAnalyzing ? (retryCount > 0 ? 'bg-indigo-100 text-indigo-600 cursor-wait shadow-inner border border-indigo-200' : 'bg-indigo-100 text-indigo-500 cursor-wait') :
                    'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md hover:shadow-lg active:scale-95'
                  }`}
                >
                  {isAnalyzing ? (
                    retryCount > 0 ? (
                      <><RefreshCw className="w-4 h-4 animate-spin" /> AI 正在努力擠進伺服器 ({retryCount}/5)...</>
                    ) : (
                      <><RefreshCw className="w-4 h-4 animate-spin" /> 疾速分析中...</>
                    )
                  ) : (
                    <>🚀 開始 AI 分析</>
                  )}
                </button>
              </div>

              {analyzeError && (
                <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg mb-4 text-sm font-medium border border-red-200">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  {analyzeError}
                </div>
              )}

              {analyzeSuccess && (
                <div className="flex items-center gap-2 text-green-600 bg-green-50 p-3 rounded-lg mb-4 text-sm font-medium">
                  <CheckCircle className="w-5 h-5 shrink-0" />
                  AI 分析完成！請確認或微調以下數值。
                </div>
              )}

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

              <div className="flex gap-3 mt-6">
                {editingId && (
                  <button 
                    onClick={cancelEdit}
                    className="w-1/3 py-4 bg-slate-200 text-slate-600 rounded-xl font-bold text-lg hover:bg-slate-300 transition-colors"
                  >
                    取消編輯
                  </button>
                )}
                <button 
                  onClick={saveToDatabase}
                  className={`${editingId ? 'w-2/3 bg-indigo-600 hover:bg-indigo-700' : 'w-full bg-slate-900 hover:bg-slate-800'} text-white rounded-xl font-bold text-lg shadow-lg flex items-center justify-center gap-2 transition-transform active:scale-[0.98]`}
                >
                  <Save className="w-5 h-5" />
                  {editingId ? '更新並返回商品庫' : '儲存至後台，完成今日進度！'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* --- 原有的 Database 分頁 --- */}
        {activeTab === 'database' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50">
              <div>
                <h2 className="font-bold text-lg text-slate-700">商品庫 (目前顯示 {filteredDatabase.length} 筆)</h2>
                <p className="text-xs text-slate-500 mt-1">這些是你努力的成果，快把他們上架到賣場吧！</p>
                {!db && <p className="text-xs font-bold text-red-500 mt-2">⚠️ 尚未連結雲端資料庫，請至「設定」配置 Firebase</p>}
                {authError && <p className="text-xs font-bold text-red-500 mt-2">⚠️ 登入發生錯誤: {authError}</p>}
                {!user && !authError && <p className="text-xs font-bold text-amber-600 mt-2">⚠️ 請先點擊右上角登入 Google 帳號，才能讀取雲端資料。</p>}
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
                  {!searchTerm && user && (
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
                          <div className="flex flex-col items-center gap-2 mt-1">
                            <button 
                              onClick={() => handleEdit(item)}
                              className="p-2 text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                              title="編輯這件商品"
                            >
                              <Edit className="w-5 h-5" />
                            </button>
                            <button 
                              onClick={() => deleteItem(item.id)}
                              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                              title="刪除"
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* --- 原有的 Settings 分頁 --- */}
        {activeTab === 'settings' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden max-w-2xl mx-auto">
            <div className="p-5 border-b border-slate-100 bg-slate-50/50">
              <h2 className="font-bold text-lg text-slate-700 flex items-center gap-2"><Settings className="w-5 h-5 text-slate-500"/> 系統引擎設定</h2>
              <p className="text-xs text-slate-500 mt-1">在這裡輸入你的專屬金鑰，讓小幫手擁有大腦和雲端保險箱。這段設定只會存在你的瀏覽器中，非常安全。</p>
            </div>
            
            <div className="p-6 space-y-8">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">1. AI 引擎鑰匙 (Gemini API Key)</label>
                <input 
                  type="password" 
                  value={geminiKeyInput} 
                  onChange={(e) => setGeminiKeyInput(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-sm"
                  placeholder="AIzaSy..."
                />
              </div>

              <hr className="border-slate-100" />

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">2. 雲端保險箱設定 (Firebase Config)</label>
                <textarea 
                  value={firebaseConfigInput} 
                  onChange={(e) => setFirebaseConfigInput(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-xs h-40"
                  placeholder={`{\n  "apiKey": "...",\n  "authDomain": "...",\n  "projectId": "...",\n  "storageBucket": "...",\n  "messagingSenderId": "...",\n  "appId": "..."\n}`}
                />
              </div>

              <hr className="border-slate-100" />

              <div>
                <label className="block text-sm font-bold text-slate-700 mb-2">3. AI 模型版本 (進階設定)</label>
                <input 
                  type="text" 
                  value={modelInput} 
                  onChange={(e) => setModelInput(e.target.value)}
                  className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-sm"
                  placeholder="gemini-2.5-flash"
                />
              </div>

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
