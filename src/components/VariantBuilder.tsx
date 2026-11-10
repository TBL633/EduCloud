import React, { useState } from 'react';
import { Plus, Trash2, Scale, Droplet, Package, Sparkles } from 'lucide-react';

export interface ProductVariant {
  variant: string;
  price: number;
  mrp?: number;
}

export interface VariantBuilderProps {
  unitType: string;
  onUnitTypeChange: (unit: string) => void;
  variants: ProductVariant[];
  onVariantsChange: (variants: ProductVariant[]) => void;
}

export const VariantBuilder: React.FC<VariantBuilderProps> = ({
  unitType,
  onUnitTypeChange,
  variants,
  onVariantsChange,
}) => {
  const [newLabel, setNewLabel] = useState('');
  const [newPrice, setNewPrice] = useState<number | ''>('');
  const [newMrp, setNewMrp] = useState<number | ''>('');

  const unitPresets: Record<string, string[]> = {
    weight: ['100g', '250g', '500g', '1 kg', '2 kg', '5 kg'],
    volume: ['100ml', '250ml', '500ml', '1 L', '2 L', '5 L'],
    pieces: ['1 Pc', '2 Pcs', '1 Pack', '1 Dozen'],
    size: ['S', 'M', 'L', 'XL', 'XXL', 'Half', 'Full'],
  };

  const handleAddPreset = (label: string) => {
    if (variants.some((v) => v.variant.toLowerCase() === label.toLowerCase())) {
      return;
    }
    onVariantsChange([...variants, { variant: label, price: 0, mrp: 0 }]);
  };

  const handleAddCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;
    onVariantsChange([
      ...variants,
      {
        variant: newLabel.trim(),
        price: Number(newPrice) || 0,
        mrp: Number(newMrp) || Number(newPrice) || 0,
      },
    ]);
    setNewLabel('');
    setNewPrice('');
    setNewMrp('');
  };

  const handleUpdateVariant = (index: number, field: keyof ProductVariant, value: any) => {
    const updated = [...variants];
    updated[index] = { ...updated[index], [field]: value };
    onVariantsChange(updated);
  };

  const handleRemoveVariant = (index: number) => {
    onVariantsChange(variants.filter((_, i) => i !== index));
  };

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-bold text-white flex items-center gap-2">
            <Sparkles size={16} className="text-emerald-400" />
            Unit Varieties & Pricing Tiers
          </h4>
          <p className="text-xs text-slate-400 mt-0.5">
            Set custom prices for different weights, volumes, packs, or sizes.
          </p>
        </div>
      </div>

      {/* Unit Type Presets Tabs */}
      <div className="flex flex-wrap gap-2 pt-1">
        {[
          { id: 'weight', label: 'Weight (KG / g)', icon: Scale },
          { id: 'volume', label: 'Volume (Litre / ml)', icon: Droplet },
          { id: 'pieces', label: 'Count (Pieces / Packs)', icon: Package },
          { id: 'size', label: 'Sizes / Portions', icon: Sparkles },
        ].map((type) => {
          const Icon = type.icon;
          const isSelected = unitType === type.id;
          return (
            <button
              key={type.id}
              type="button"
              onClick={() => onUnitTypeChange(type.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                isSelected
                  ? 'bg-emerald-500 text-slate-950 font-bold shadow-sm'
                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              <Icon size={14} />
              {type.label}
            </button>
          );
        })}
      </div>

      {/* Preset Quick Chips */}
      {unitPresets[unitType] && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Quick Add Preset:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {unitPresets[unitType].map((preset) => {
              const isAdded = variants.some((v) => v.variant.toLowerCase() === preset.toLowerCase());
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => handleAddPreset(preset)}
                  disabled={isAdded}
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono font-medium transition cursor-pointer ${
                    isAdded
                      ? 'bg-emerald-950/40 text-emerald-500 border border-emerald-800/40 cursor-not-allowed opacity-60'
                      : 'bg-slate-800/80 hover:bg-emerald-600 hover:text-white text-slate-300 border border-slate-700/60'
                  }`}
                >
                  + {preset}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Active Variants List */}
      {variants.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-slate-800">
          <div className="grid grid-cols-12 gap-2 text-[11px] font-bold text-slate-400 uppercase tracking-wider px-1">
            <span className="col-span-5">Variant Label</span>
            <span className="col-span-3">Sale Price (₹)</span>
            <span className="col-span-3">MRP (₹)</span>
            <span className="col-span-1 text-center">Action</span>
          </div>

          <div className="space-y-2">
            {variants.map((v, idx) => (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 items-center bg-slate-950/70 border border-slate-800/80 p-2 rounded-xl"
              >
                <div className="col-span-5">
                  <input
                    type="text"
                    value={v.variant}
                    onChange={(e) => handleUpdateVariant(idx, 'variant', e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-white outline-none focus:border-emerald-500"
                    placeholder="e.g. 500g"
                  />
                </div>
                <div className="col-span-3">
                  <input
                    type="number"
                    value={v.price || ''}
                    onChange={(e) => handleUpdateVariant(idx, 'price', Number(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-emerald-400 font-bold outline-none focus:border-emerald-500"
                    placeholder="₹ Sale"
                  />
                </div>
                <div className="col-span-3">
                  <input
                    type="number"
                    value={v.mrp || ''}
                    onChange={(e) => handleUpdateVariant(idx, 'mrp', Number(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-700/80 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 outline-none focus:border-emerald-500"
                    placeholder="₹ MRP"
                  />
                </div>
                <div className="col-span-1 flex justify-center">
                  <button
                    type="button"
                    onClick={() => handleRemoveVariant(idx)}
                    className="text-slate-500 hover:text-rose-400 p-1.5 rounded-lg hover:bg-rose-500/10 transition cursor-pointer"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Custom Add Row Form */}
      <form onSubmit={handleAddCustom} className="flex gap-2 pt-2">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Custom label (e.g. 750ml, Family Pack)"
          className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-600 outline-none focus:border-emerald-500"
        />
        <input
          type="number"
          value={newPrice}
          onChange={(e) => setNewPrice(e.target.value ? Number(e.target.value) : '')}
          placeholder="₹ Price"
          className="w-24 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-emerald-400 font-bold placeholder-slate-600 outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          className="px-3.5 py-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-bold flex items-center gap-1 transition cursor-pointer"
        >
          <Plus size={14} />
          Add
        </button>
      </form>
    </div>
  );
};
