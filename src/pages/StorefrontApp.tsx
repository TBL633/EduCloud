import React, { useState, useEffect } from 'react';
import {
  Store,
  ShoppingBag,
  Search,
  ShoppingCart,
  ChevronDown,
  Check,
  Plus,
  Minus,
  Sparkles,
  ShieldCheck,
  CreditCard,
  Truck
} from 'lucide-react';
import { PaymentModal } from '../components/PaymentModal.js';

export interface ProductVariant {
  variant: string;
  price: number;
  mrp?: number;
}

export interface StoreProduct {
  id: number;
  name: string;
  price: number | string;
  mrp?: number | string;
  details?: string;
  category?: string;
  sub_category?: string;
  images?: string[];
  image_url?: string;
  in_stock?: boolean;
  unit_type?: string;
  variants?: ProductVariant[];
}

export interface CartItem {
  id: number;
  name: string;
  price: number;
  variantLabel: string;
  quantity: number;
  image?: string;
}

export const StorefrontApp: React.FC = () => {
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [storeName, setStoreName] = useState('WaMart Official Store');

  // Checkout & Payment Modal State
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [activeOrderId, setActiveOrderId] = useState('');
  const [activePaymentAmount, setActivePaymentAmount] = useState(0);

  // Selected variant map per product ID: { [productId]: selectedVariantLabel }
  const [selectedVariants, setSelectedVariants] = useState<Record<number, string>>({});

  useEffect(() => {
    // Fetch products and categories from backend
    const fetchCatalog = async () => {
      try {
        const res = await fetch('/api/storefront');
        if (res.ok) {
          const data = await res.json();
          if (data.products) setProducts(data.products);
          if (data.store_name) setStoreName(data.store_name);

          // Extract unique categories
          if (data.products) {
            const cats = Array.from(
              new Set(
                data.products
                  .map((p: StoreProduct) => p.category)
                  .filter(Boolean)
              )
            ) as string[];
            setCategories(['All', ...cats]);
          }
        }
      } catch (err) {
        console.error('Failed to load store catalog:', err);
      }
    };

    fetchCatalog();
  }, []);

  const handleSelectVariant = (productId: number, variantLabel: string) => {
    setSelectedVariants((prev) => ({ ...prev, [productId]: variantLabel }));
  };

  const getProductActivePrice = (product: StoreProduct) => {
    const selectedVariantLabel = selectedVariants[product.id];
    if (selectedVariantLabel && product.variants && product.variants.length > 0) {
      const match = product.variants.find((v) => v.variant === selectedVariantLabel);
      if (match) return Number(match.price);
    }
    return Number(product.price) || 0;
  };

  const handleAddToCart = (product: StoreProduct) => {
    const activePrice = getProductActivePrice(product);
    const selectedVariantLabel =
      selectedVariants[product.id] ||
      (product.variants && product.variants.length > 0 ? product.variants[0].variant : 'Standard');

    const primaryImg =
      product.images && product.images.length > 0
        ? product.images[0]
        : product.image_url || 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=500&auto=format&fit=crop&q=60';

    setCart((prev) => {
      const existing = prev.find(
        (item) => item.id === product.id && item.variantLabel === selectedVariantLabel
      );
      if (existing) {
        return prev.map((item) =>
          item.id === product.id && item.variantLabel === selectedVariantLabel
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }
      return [
        ...prev,
        {
          id: product.id,
          name: product.name,
          price: activePrice,
          variantLabel: selectedVariantLabel,
          quantity: 1,
          image: primaryImg,
        },
      ];
    });
  };

  const updateCartQty = (id: number, variantLabel: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.id === id && item.variantLabel === variantLabel) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean) as CartItem[]
    );
  };

  const cartTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const handleCheckout = async (paymentMethod: 'online' | 'cod') => {
    if (cart.length === 0) return;

    if (paymentMethod === 'online') {
      const generatedOrderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
      setActiveOrderId(generatedOrderId);
      setActivePaymentAmount(cartTotal);
      setIsPaymentModalOpen(true);
      setIsCartOpen(false);
    } else {
      // COD flow - trigger WhatsApp or API checkout
      try {
        await fetch('/api/orders/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: cart,
            total: cartTotal,
            payment_mode: 'cod',
          }),
        });
        alert('Your COD Order has been confirmed and placed successfully!');
        setCart([]);
        setIsCartOpen(false);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const filteredProducts = products.filter((p) => {
    const matchesCat = selectedCategory === 'All' || p.category === selectedCategory;
    const matchesQuery = p.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesQuery;
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-black shadow-lg shadow-emerald-500/20">
              <Store size={22} />
            </div>
            <div>
              <h1 className="text-base font-black text-white leading-tight">{storeName}</h1>
              <span className="text-[11px] text-emerald-400 font-bold uppercase tracking-wider flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                Live WhatsApp Store
              </span>
            </div>
          </div>

          {/* Search bar */}
          <div className="hidden md:flex flex-1 max-w-md relative">
            <Search className="absolute left-3.5 top-3 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search in store (e.g. Atta, Oil, Milk)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950/80 border border-slate-700/80 rounded-xl pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 outline-none focus:border-emerald-500"
            />
          </div>

          {/* Cart Button */}
          <button
            onClick={() => setIsCartOpen(true)}
            className="relative px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl flex items-center gap-2 transition cursor-pointer shadow-md shadow-emerald-500/20"
          >
            <ShoppingCart size={18} />
            <span className="text-xs">Cart</span>
            {cart.length > 0 && (
              <span className="bg-slate-950 text-white font-mono text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                {cart.reduce((sum, item) => sum + item.quantity, 0)}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl mx-auto px-4 py-6 w-full space-y-6">
        {/* Categories Bar */}
        {categories.length > 1 && (
          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition whitespace-nowrap cursor-pointer ${
                  selectedCategory === cat
                    ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20'
                    : 'bg-slate-900 border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Product Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filteredProducts.map((product) => {
            const activePrice = getProductActivePrice(product);
            const activeVariant =
              selectedVariants[product.id] ||
              (product.variants && product.variants.length > 0 ? product.variants[0].variant : '');

            const primaryImg =
              product.images && product.images.length > 0
                ? product.images[0]
                : product.image_url || 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=500&auto=format&fit=crop&q=60';

            return (
              <div
                key={product.id}
                className="bg-slate-900/80 border border-slate-800/80 hover:border-slate-700 rounded-2xl overflow-hidden flex flex-col group transition"
              >
                {/* Product Image */}
                <div className="relative aspect-square bg-slate-950 overflow-hidden">
                  <img
                    src={primaryImg}
                    alt={product.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                  />
                  {product.category && (
                    <span className="absolute top-2 left-2 bg-slate-950/80 backdrop-blur-md text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-lg border border-slate-800">
                      {product.category}
                    </span>
                  )}
                </div>

                {/* Details */}
                <div className="p-3.5 flex-1 flex flex-col justify-between space-y-3">
                  <div>
                    <h3 className="text-xs font-bold text-white line-clamp-2 leading-snug">
                      {product.name}
                    </h3>
                    {product.sub_category && (
                      <span className="text-[10px] text-slate-400 block mt-0.5 font-medium">
                        {product.sub_category}
                      </span>
                    )}
                  </div>

                  {/* Variety / Variant selector pills */}
                  {product.variants && product.variants.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500">
                        Choose Variety:
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {product.variants.map((v) => {
                          const isSelected = activeVariant === v.variant;
                          return (
                            <button
                              key={v.variant}
                              type="button"
                              onClick={() => handleSelectVariant(product.id, v.variant)}
                              className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-bold transition cursor-pointer ${
                                isSelected
                                  ? 'bg-emerald-500 text-slate-950'
                                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                              }`}
                            >
                              {v.variant}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Pricing and Add button */}
                  <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-slate-400 block">Price</span>
                      <span className="text-sm font-black text-emerald-400">
                        ₹{activePrice}
                      </span>
                    </div>

                    <button
                      onClick={() => handleAddToCart(product)}
                      className="px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 font-bold rounded-xl text-xs border border-emerald-500/30 transition flex items-center gap-1 cursor-pointer active:scale-95"
                    >
                      <Plus size={14} />
                      Add
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* Cart Drawer */}
      {isCartOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-slate-900 border-l border-slate-800 flex flex-col h-full shadow-2xl">
            {/* Drawer Header */}
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <ShoppingBag size={18} className="text-emerald-400" />
                Your Shopping Bag ({cart.length})
              </h2>
              <button
                onClick={() => setIsCartOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                ✕
              </button>
            </div>

            {/* Cart Items */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cart.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
                  <ShoppingBag size={40} className="mb-2 opacity-40" />
                  <p className="text-sm font-semibold">Your cart is empty</p>
                  <p className="text-xs text-slate-500 mt-1">Add items from the store to proceed.</p>
                </div>
              ) : (
                cart.map((item) => (
                  <div
                    key={`${item.id}-${item.variantLabel}`}
                    className="flex items-center gap-3 bg-slate-950/60 p-3 rounded-xl border border-slate-800"
                  >
                    {item.image && (
                      <img
                        src={item.image}
                        alt={item.name}
                        className="w-12 h-12 rounded-lg object-cover bg-slate-900"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <h4 className="text-xs font-bold text-white truncate">{item.name}</h4>
                      <span className="text-[10px] text-emerald-400 font-mono font-semibold block">
                        {item.variantLabel}
                      </span>
                      <span className="text-xs font-black text-slate-200">
                        ₹{item.price * item.quantity}
                      </span>
                    </div>

                    {/* Qty controls */}
                    <div className="flex items-center gap-2 bg-slate-900 px-2 py-1 rounded-lg border border-slate-800">
                      <button
                        onClick={() => updateCartQty(item.id, item.variantLabel, -1)}
                        className="text-slate-400 hover:text-white"
                      >
                        <Minus size={12} />
                      </button>
                      <span className="text-xs font-bold text-white font-mono w-4 text-center">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => updateCartQty(item.id, item.variantLabel, 1)}
                        className="text-slate-400 hover:text-white"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Drawer Footer Checkout */}
            {cart.length > 0 && (
              <div className="p-4 border-t border-slate-800 bg-slate-950/80 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-400 font-medium">Grand Total</span>
                  <span className="text-xl font-black text-white">₹{cartTotal}</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleCheckout('online')}
                    className="py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-lg shadow-blue-600/20"
                  >
                    <CreditCard size={15} />
                    Online UPI Pay
                  </button>

                  <button
                    onClick={() => handleCheckout('cod')}
                    className="py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    <Truck size={15} />
                    Cash on Delivery
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Premium QR Payment Modal */}
      <PaymentModal
        isOpen={isPaymentModalOpen}
        onClose={() => setIsPaymentModalOpen(false)}
        orderId={activeOrderId}
        amount={activePaymentAmount}
        storeName={storeName}
        onSuccess={() => {
          setCart([]);
        }}
      />
    </div>
  );
};
