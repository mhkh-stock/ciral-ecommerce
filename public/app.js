let products = []; let catalog = {}; let cart = JSON.parse(localStorage.getItem('ciral_cart') || '[]');
let portalToken = localStorage.getItem('ciral_portal_token') || '', portalCsrf = localStorage.getItem('ciral_portal_csrf') || '';
let suggestCache = {}, detailProd = null, detailImages = [];
// Escape anything that came from the database or another user before it goes
// into innerHTML. Names, reviews and messages are user-supplied text: without
// this, a crafted account/product name executes as HTML in every other
// visitor's browser (stored XSS).
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clickSound(){ try{ const c=new (window.AudioContext||window.webkitAudioContext)(); const o=c.createOscillator(), g=c.createGain(); o.frequency.value=900; g.gain.setValueAtTime(.08,c.currentTime); g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.08); o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime+.09);}catch(e){} }
function toast(m){ const t=document.getElementById('toast'); t.textContent=m; t.style.display='block'; setTimeout(()=>t.style.display='none',3500); }
function pkr(n){ return 'PKR '+Number(n).toLocaleString('en-PK'); }
function stars(avg){ const r=Math.round(avg||0); return '★'.repeat(r)+'☆'.repeat(5-r); }
function priceHtml(p){ const eff=p.deal_price||p.price; return p.deal_price?`<span style="text-decoration:line-through" class="muted">${pkr(p.price)}</span> <b class="price">${pkr(eff)}</b> <span class="badge">-${Math.round((1-eff/p.price)*100)}%</span>`:`<p class="price">${pkr(p.price)}</p>`; }
function cardHtml(p){ const eff=p.deal_price||p.price; return `<div class="card"><div class="emoji">${esc(p.image_emoji)}</div><h3 style="cursor:pointer" onclick="showDetail(${p.id})">${esc(p.name)}</h3>
<p class="muted">${esc(p.category)} · ${p.stock} in stock · ${stars(p.avg_rating?p.avg_rating.a:0)} ${p.avg_rating&&p.avg_rating.c?`(${p.avg_rating.c})`:''}</p><p>${esc(p.description)}</p>
${priceHtml(p)}
<button onclick="showDetail(${p.id})" class="ghost">View Details</button> <button onclick="addToCart(${p.id})" ${p.stock<=0?'disabled':''}>${p.stock<=0?'Out of Stock':'Add to Cart'}</button> <button class="ghost" onclick="addWish(${p.id})">♡ Wishlist</button></div>`; }
async function loadProducts(){
  const q=document.getElementById('q').value, cat=document.getElementById('cat').value, sort=document.getElementById('sort').value, minP=document.getElementById('minP').value, maxP=document.getElementById('maxP').value;
  const r=await fetch('/api/products?q='+encodeURIComponent(q)+'&category='+encodeURIComponent(cat)+'&sort='+encodeURIComponent(sort)+'&min_price='+encodeURIComponent(minP)+'&max_price='+encodeURIComponent(maxP));
  products=await r.json(); products.forEach(p=>catalog[p.id]=p);
  document.getElementById('grid').innerHTML=products.map(cardHtml).join('') || '<p>No products found.</p>';
  renderCart();
}
async function loadSections(){
  try{
    const deals=await (await fetch('/api/deals')).json();
    document.getElementById('dealsGrid').innerHTML=deals.map(d=>cardHtml({id:d.product_id,name:d.name,category:d.category,price:d.price,stock:d.stock,description:d.label+' — ends soon',image_emoji:d.image_emoji,deal_price:d.deal_price})).join('') || '<p>No deals today.</p>';
    document.getElementById('banners').innerHTML=`<div class="banner" onclick="filterCat('Electronics')">🔥 Electronics Deals — up to 25% off <span>Shop Electronics →</span></div><div class="banner" onclick="filterCat('Clothing')">👕 New Season Clothing <span>Shop Clothing →</span></div>`;
    const best=await (await fetch('/api/best-sellers')).json(); document.getElementById('bestGrid').innerHTML=best.map(cardHtml).join('');
    const nw=await (await fetch('/api/new-arrivals')).json(); document.getElementById('newGrid').innerHTML=nw.map(cardHtml).join('');
    const cats=await (await fetch('/api/categories')).json(); document.getElementById('catGrid').innerHTML=cats.map(c=>`<div class="card" style="cursor:pointer" onclick="filterCat('${c.category}')"><h3>${c.category}</h3><p class="muted">${c.count} products</p><button class="ghost">Shop ${c.category} →</button></div>`).join('');
    const rec=await (await fetch('/api/recommendations')).json(); document.getElementById('recGrid').innerHTML=rec.map(cardHtml).join('');
  }catch(e){ console.error(e); }
}
function filterCat(c){ document.getElementById('cat').value=c; loadProducts(); document.getElementById('grid').scrollIntoView(); }
let suggestTimer=null;
function onSearchInput(){ clearTimeout(suggestTimer); suggestTimer=setTimeout(async()=>{ const q=document.getElementById('q').value.trim(); const box=document.getElementById('suggest'); if(q.length<2){ box.style.display='none'; loadProducts(); return; } const r=await fetch('/api/search-suggestions?q='+encodeURIComponent(q)); const s=await r.json(); suggestCache={}; s.forEach(x=>suggestCache[x.id]=x); box.innerHTML=s.map(x=>`<div onclick="pickSuggest(${x.id})">${esc(x.name)} — ${pkr(x.deal_price||x.price)}</div>`).join('')||''; box.style.display=s.length?'block':'none'; },250); }
function pickSuggest(id){ const s=suggestCache[id]; if(s) document.getElementById('q').value=s.name; document.getElementById('suggest').style.display='none'; loadProducts(); }
async function showDetail(id){
  const r=await fetch('/api/products/'+id+'/detail'); if(!r.ok) return toast('Product not found'); const p=await r.json(); catalog[p.id]=p; detailProd=p; detailImages=p.images||[];
  const gal=p.images&&p.images.length?p.images:[{url:'',label:'Product'}];
  document.getElementById('detailBody').innerHTML=`<div id="galMain" style="font-size:64px;text-align:center">${p.images&&p.images.length?`<img src="${esc(gal[0].url)}" style="max-width:100%;border-radius:12px" onerror="this.outerHTML='<div style=font-size:64px>${esc(p.image_emoji)}</div>'">`:`<div>${esc(p.image_emoji)}</div>`}</div>
  <div>${gal.map((g,i)=>`<button class="small ghost" onclick="galShow(${i})">${esc(g.label)}</button>`).join('')}</div>
  <p class="muted">Gallery images are generic category placeholders, not photos of the exact product.</p>
  <h2>${esc(p.name)}</h2><p class="muted">${esc(p.category)} · ${p.stock} in stock · ${stars(p.avg_rating?p.avg_rating.a:0)} (${p.avg_rating?p.avg_rating.c:0} reviews)</p><p>${esc(p.description)}</p>${priceHtml(p)}
  <button onclick="addToCart(${p.id});hideDetail()" ${p.stock<=0?'disabled':''}>${p.stock<=0?'Out of Stock':'Add to Cart'}</button> <button class="ghost" onclick="addWish(${p.id})">♡ Wishlist</button> <button class="ghost" onclick="location.href='customer.html?msg_product=${p.id}'">💬 Ask about this product</button>
  <h3>Reviews</h3><div>${p.reviews.map(rv=>`<p>${stars(rv.rating)} <b>${esc(rv.customer_name)}</b> — ${esc(rv.comment||'')}</p>`).join('')||'<p>No reviews yet.</p>'}</div>
  <div id="revForm"><input id="revRating" type="number" min="1" max="5" placeholder="Rating 1–5"><input id="revComment" placeholder="Your review (sign in as a customer first)"><button class="ghost" onclick="postReview(${p.id})">Submit Review</button></div>
  <h3>Related Products</h3><div class="grid">${p.related.map(cardHtml).join('')}</div>`;
  document.getElementById('detailModal').style.display='flex';
}
function galShow(i){ const m=document.getElementById('galMain'); const g=detailImages[i]; const emoji=detailProd?detailProd.image_emoji:'🛍️'; m.innerHTML=g&&g.url?`<img src="${esc(g.url)}" style="max-width:100%;border-radius:12px" onerror="this.outerHTML='<div style=font-size:64px>${esc(emoji)}</div>'">`:`<div style="font-size:64px">${esc(emoji)}</div>`; }
function hideDetail(){ document.getElementById('detailModal').style.display='none'; }
async function postReview(pid){ if(!portalToken) return toast('Please sign in on the My Account page first'); const rating=document.getElementById('revRating').value, comment=document.getElementById('revComment').value; const r=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+portalToken,'X-CSRF-Token':portalCsrf},body:JSON.stringify({product_id:pid,rating:parseInt(rating),comment})}); const j=await r.json(); if(!r.ok) return toast(j.error||'Review failed'); toast('Review submitted'); showDetail(pid); }
async function addWish(id){ if(!portalToken) return toast('Please sign in on the My Account page to use the wishlist'); const r=await fetch('/api/wishlist',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+portalToken,'X-CSRF-Token':portalCsrf},body:JSON.stringify({product_id:id})}); const j=await r.json(); toast(r.ok?'Added to wishlist':(j.error||'Wishlist failed')); }
function saveCart(){ localStorage.setItem('ciral_cart', JSON.stringify(cart)); document.getElementById('cartCount').textContent=cart.reduce((s,i)=>s+i.qty,0); renderCart(); }
function addToCart(id){ clickSound(); const p=catalog[id]; const it=cart.find(i=>i.product_id===id); const cur=it?it.qty:0; const eff=p?(p.deal_price||p.price):0; if(p && p.stock<=cur){ toast('No more in stock for this product'); return; } if(it) it.qty++; else cart.push({product_id:id,qty:1}); saveCart(); toast('Added to cart'); }
function changeQty(id,d){ const it=cart.find(i=>i.product_id===id); if(!it) return; it.qty+=d; if(it.qty<=0) cart=cart.filter(i=>i.product_id!==id); else if(catalog[id] && it.qty>catalog[id].stock){ it.qty=catalog[id].stock; toast('Only '+catalog[id].stock+' in stock'); } saveCart(); }
function removeFromCart(id){ cart=cart.filter(i=>i.product_id!==id); saveCart(); }
function cartTotal(){ return cart.reduce((s,i)=>{ const p=catalog[i.product_id]; return s+(p?(p.deal_price||p.price):0)*i.qty; },0); }
function renderCart(){
  const box=document.getElementById('cartItems'); let total=cartTotal();
  box.innerHTML=cart.map(i=>{ const p=catalog[i.product_id] || {name:'Product',price:0}; const eff=p.deal_price||p.price; return `<p>${esc(p.name)} × ${i.qty} — ${pkr(eff*i.qty)} <button class="small ghost" onclick="changeQty(${i.product_id},-1)">−</button> <button class="small ghost" onclick="changeQty(${i.product_id},1)">+</button> <button class="small ghost" onclick="removeFromCart(${i.product_id})">Remove</button></p>`; }).join('') || '<p>Your cart is empty.</p>';
  document.getElementById('cartTotal').textContent='Total: '+pkr(total);
  const ck=document.getElementById('ckCart'); if(ck) ck.innerHTML=box.innerHTML;
}
function toggleCart(){ clickSound(); const d=document.getElementById('cartDrawer'); d.style.display=d.style.display==='none'?'block':'none'; }
async function ckGo(n){ for(let i=1;i<=4;i++){ document.getElementById('ckStep'+i).style.display=i===n?'block':'none'; } document.querySelectorAll('#ckSteps .step').forEach((el,i)=>el.classList.toggle('active',i+1<=n)); if(n===4){
  // Step 4 shows the full working before the customer commits: subtotal at
  // real (deal) prices, the coupon discount validated live, delivery, total.
  const subtotal=cartTotal(); const code=(document.getElementById('cCoupon').value||'').trim(); let discount=0, couponNote='Coupon: none';
  if(code){ try{ const cr=await fetch('/api/coupons/check?code='+encodeURIComponent(code)); if(cr.ok){ const cj=await cr.json(); discount=Math.round(subtotal*cj.percent/100); couponNote=`Coupon ${esc(cj.code)} (−${cj.percent}%): −${pkr(discount)}`; } else couponNote=`Coupon ${esc(code)} not recognised — no discount applied`; }catch(e){ couponNote='Coupon could not be checked — no discount applied'; } }
  const total=subtotal-discount;
  document.getElementById('checkoutTotal').textContent='Total: '+pkr(total);
  document.getElementById('ckReview').innerHTML=`<p>Subtotal: ${pkr(subtotal)}</p><p>${couponNote}</p><p>Delivery: FREE</p><p><b>Total: ${pkr(total)}</b></p><p>${esc(document.getElementById('cName').value)} — ${esc(document.getElementById('cCity').value)}</p><p>Payment: ${esc(document.getElementById('cPay').value)}</p>`;
} }
function showCheckout(){ if(!cart.length) return toast('Your cart is empty'); ckGo(1); document.getElementById('checkoutModal').style.display='flex'; }
function hideCheckout(){ document.getElementById('checkoutModal').style.display='none'; }
async function placeOrder(){
  clickSound();
  const body={ name:document.getElementById('cName').value, phone:document.getElementById('cPhone').value, city:document.getElementById('cCity').value, address:document.getElementById('cAddress').value, payment_method:document.getElementById('cPay').value, coupon_code:document.getElementById('cCoupon').value||undefined, items:cart };
  const headers={'Content-Type':'application/json'}; if(portalToken){ headers.Authorization='Bearer '+portalToken; }
  const r=await fetch('/api/checkout',{method:'POST',headers,body:JSON.stringify(body)});
  const j=await r.json();
  if(!r.ok) return toast(j.error||'Checkout failed');
  cart=[]; saveCart(); hideCheckout(); toggleCart();
  toast('Order placed! Your order number is '+j.order_id+' · Total '+pkr(j.total)+(j.discount?` · Discount ${pkr(j.discount)}`:'')+'. Thank you for shopping with Ciral.');
}
loadProducts(); loadSections(); saveCart();
