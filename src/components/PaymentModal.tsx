import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  QrCode,
  Clock,
  ArrowRight,
  RotateCw,
  X,
  CheckCircle2,
  Lock,
  Smartphone,
  AlertTriangle
} from 'lucide-react';

export interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  amount: number;
  qrPayload?: string;
  storeName?: string;
  onSuccess?: () => void;
  onExpire?: () => void;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  orderId,
  amount,
  qrPayload,
  storeName = 'WaMart Store',
  onSuccess,
  onExpire,
}) => {
  const [timeLeft, setTimeLeft] = useState(300); // 5:00 minutes
  const [isExpired, setIsExpired] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<'pending' | 'verifying' | 'paid' | 'failed'>('pending');

  // Countdown timer
  useEffect(() => {
    if (!isOpen) {
      setTimeLeft(300);
      setIsExpired(false);
      setPaymentStatus('pending');
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setIsExpired(true);
          if (onExpire) onExpire();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen, onExpire]);

  // Polling payment status from Golang backend
  useEffect(() => {
    if (!isOpen || isExpired || paymentStatus === 'paid') return;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/orders/status/${orderId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'PAID' || data.status === 'SUCCESS' || data.is_paid) {
            setPaymentStatus('paid');
            clearInterval(pollInterval);
            if (onSuccess) onSuccess();
          }
        }
      } catch (err) {
        // Silently continue polling
      }
    }, 2500);

    return () => clearInterval(pollInterval);
  }, [isOpen, isExpired, orderId, paymentStatus, onSuccess]);

  if (!isOpen) return null;

  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;
  const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  // Generate QR image URL using standard Google Charts or custom dynamic endpoint
  const qrImageUrl = qrPayload
    ? `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(qrPayload)}`
    : `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=upi://pay?pa=paytmqr@paytm&am=${amount}&pn=${encodeURIComponent(storeName)}`;

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-md bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden relative">
        {/* Top Gradient Header */}
        <div className="bg-gradient-to-r from-blue-700 via-indigo-600 to-blue-800 p-5 text-white relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white/80 hover:text-white transition cursor-pointer"
          >
            <X size={18} />
          </button>

          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs uppercase tracking-widest bg-white/20 px-2.5 py-0.5 rounded-full font-bold">
              Instant Payment
            </span>
          </div>
          <h2 className="text-xl font-black tracking-tight">{storeName}</h2>
          <p className="text-xs text-blue-100/90 font-medium mt-0.5">
            Scan & Pay • Fast • Secure • Zero Surcharge
          </p>
        </div>

        {/* Modal Body */}
        <div className="p-6 flex flex-col items-center">
          {paymentStatus === 'paid' ? (
            <div className="py-8 flex flex-col items-center text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center justify-center animate-bounce">
                <CheckCircle2 size={36} />
              </div>
              <h3 className="text-xl font-bold text-white">Payment Received!</h3>
              <p className="text-sm text-slate-400">
                Order <span className="font-mono text-emerald-400 font-bold">#{orderId}</span> is confirmed. Your receipt has been dispatched to WhatsApp!
              </p>
              <button
                onClick={onClose}
                className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold rounded-xl transition cursor-pointer mt-4"
              >
                Done
              </button>
            </div>
          ) : isExpired ? (
            <div className="py-8 flex flex-col items-center text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/30 flex items-center justify-center">
                <AlertTriangle size={36} />
              </div>
              <h3 className="text-xl font-bold text-white">Payment Session Expired</h3>
              <p className="text-sm text-slate-400">
                The 5-minute payment window for this QR code has ended. Please generate a new QR to complete your purchase.
              </p>
              <button
                onClick={() => {
                  setTimeLeft(300);
                  setIsExpired(false);
                }}
                className="w-full py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition cursor-pointer mt-2"
              >
                <RotateCw size={16} />
                Regenerate QR Code
              </button>
            </div>
          ) : (
            <>
              {/* Amount Pill */}
              <div className="w-full bg-slate-900/90 border border-slate-800 rounded-2xl p-4 flex items-center justify-between mb-5">
                <div>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold block">
                    Total Payable Amount
                  </span>
                  <div className="text-2xl font-black text-white tracking-tight">
                    ₹{amount.toLocaleString('en-IN')}
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 font-bold block">
                    Order ID
                  </span>
                  <span className="font-mono text-xs text-blue-400 font-bold">
                    #{orderId}
                  </span>
                </div>
              </div>

              {/* QR Code Container */}
              <div className="relative p-4 bg-white rounded-3xl shadow-xl border-4 border-blue-500/20 mb-4 group">
                <img
                  src={qrImageUrl}
                  alt="UPI QR Code"
                  className="w-56 h-56 rounded-xl object-contain"
                />
                <div className="absolute inset-0 rounded-3xl border-2 border-dashed border-blue-400/40 pointer-events-none" />
              </div>

              {/* Accepted UPI Apps Row */}
              <div className="flex items-center justify-center gap-4 text-xs font-semibold text-slate-400 my-2">
                <span className="flex items-center gap-1.5 bg-slate-800/60 px-2.5 py-1 rounded-lg border border-slate-700/50">
                  <Smartphone size={13} className="text-blue-400" /> GPay
                </span>
                <span className="flex items-center gap-1.5 bg-slate-800/60 px-2.5 py-1 rounded-lg border border-slate-700/50">
                  PhonePe
                </span>
                <span className="flex items-center gap-1.5 bg-slate-800/60 px-2.5 py-1 rounded-lg border border-slate-700/50">
                  Paytm
                </span>
                <span className="flex items-center gap-1.5 bg-slate-800/60 px-2.5 py-1 rounded-lg border border-slate-700/50">
                  BHIM
                </span>
              </div>

              {/* Countdown Timer */}
              <div className="w-full mt-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-amber-300 font-medium">
                  <Clock size={16} className="text-amber-400 animate-pulse" />
                  <span>Time remaining to pay:</span>
                </div>
                <span className="font-mono text-base font-extrabold text-amber-400">
                  {formattedTime}
                </span>
              </div>

              {/* Security Badges */}
              <div className="w-full mt-4 pt-4 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                <span className="flex items-center gap-1 text-emerald-400 font-medium">
                  <ShieldCheck size={14} /> 100% Encrypted UPI
                </span>
                <span className="flex items-center gap-1 text-slate-400">
                  <Lock size={12} /> Direct Bank Transfer
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
