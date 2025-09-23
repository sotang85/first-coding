const appRoot = document.getElementById('app');
const config = window.APP_CONFIG || {};
const API_BASE = '';
const departmentColors = {
  '경영기획': '#2563eb',
  '고객사업': '#f97316',
  '브랜드상품전략': '#8b5cf6',
  '마케팅': '#ec4899',
  '경영지원': '#10b981',
  '기타': '#475569'
};

const state = {
  token: window.localStorage.getItem('auth_token') || null,
  user: null,
  restaurants: [],
  restaurantDetails: {},
  selectedRestaurantId: null,
  departments: [],
  activeDepartments: new Set(),
  map: null,
  markers: [],
  mapReady: false
};

const ui = {
  listContainer: null,
  detailContainer: null,
  filterContainer: null,
  filterLegend: null,
  mapContainer: null,
  mapOverlay: null,
  reviewForm: null,
  addRestaurantForm: null
};

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
  }, 2600);
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

function saveToken(token) {
  state.token = token;
  if (token) {
    window.localStorage.setItem('auth_token', token);
  } else {
    window.localStorage.removeItem('auth_token');
  }
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });
  if (!response.ok) {
    let errorMessage = '요청을 처리할 수 없습니다.';
    try {
      const payload = await response.json();
      if (payload && payload.message) {
        errorMessage = payload.message;
      }
    } catch (err) {
      // ignore
    }
    throw new Error(errorMessage);
  }
  if (response.status === 204) {
    return null;
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function fetchCurrentUser() {
  const data = await apiFetch('/api/auth/me');
  state.user = data.user;
  return state.user;
}

async function fetchDepartments() {
  const data = await apiFetch('/api/meta/departments');
  state.departments = data.departments || [];
  return state.departments;
}

async function fetchRestaurants() {
  const data = await apiFetch('/api/restaurants');
  state.restaurants = data.restaurants || [];
  return state.restaurants;
}

async function fetchRestaurantDetail(restaurantId) {
  if (!restaurantId) return null;
  const data = await apiFetch(`/api/restaurants/${restaurantId}`);
  state.restaurantDetails[restaurantId] = data;
  return data;
}

function resetStateForLogout() {
  saveToken(null);
  state.user = null;
  state.restaurants = [];
  state.restaurantDetails = {};
  state.selectedRestaurantId = null;
  state.activeDepartments = new Set();
  if (state.map) {
    state.markers.forEach(marker => marker.setMap(null));
    state.markers = [];
  }
}

function createAuthView() {
  appRoot.innerHTML = `
    <div class="auth-container">
      <section class="auth-card card">
        <h1>회사 맛집 지도</h1>
        <p class="helper-text">
          팀 코드를 가진 구성원만 로그인할 수 있습니다. \n
          아직 계정이 없다면 오른쪽 가입 폼을 이용하세요.
        </p>
        <form id="login-form">
          <div>
            <label for="login-username">아이디</label>
            <input id="login-username" name="username" autocomplete="username" required />
          </div>
          <div>
            <label for="login-password">비밀번호</label>
            <input id="login-password" type="password" name="password" autocomplete="current-password" required />
          </div>
          <button class="primary" type="submit">로그인</button>
          <p class="helper-text">테스트용 기본 팀 코드는 <strong>VIBE-TEAM</strong> 입니다.</p>
        </form>
      </section>
      <section class="auth-card card">
        <h1>팀원 가입</h1>
        <form id="register-form">
          <div>
            <label for="register-username">아이디</label>
            <input id="register-username" name="username" minlength="4" required />
          </div>
          <div>
            <label for="register-display-name">이름(또는 닉네임)</label>
            <input id="register-display-name" name="displayName" required />
          </div>
          <div>
            <label for="register-department">소속 부서</label>
            <input id="register-department" name="department" placeholder="예: 경영기획" />
          </div>
          <div>
            <label for="register-password">비밀번호</label>
            <input id="register-password" type="password" name="password" minlength="6" required />
          </div>
          <div>
            <label for="register-team-code">팀 코드</label>
            <input id="register-team-code" name="teamCode" placeholder="예: VIBE-TEAM" required />
          </div>
          <button class="primary" type="submit">가입하기</button>
        </form>
      </section>
    </div>
  `;
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(loginForm);
    try {
      const payload = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: formData.get('username'),
          password: formData.get('password')
        })
      });
      saveToken(payload.token);
      state.user = payload.user;
      showToast(`${payload.user.displayName}님 환영합니다!`, 'success');
      await bootstrapAfterAuth();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  registerForm.addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(registerForm);
    try {
      const payload = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          username: formData.get('username'),
          displayName: formData.get('displayName'),
          department: formData.get('department'),
          password: formData.get('password'),
          teamCode: formData.get('teamCode')
        })
      });
      saveToken(payload.token);
      state.user = payload.user;
      showToast(`${payload.user.displayName}님 가입을 환영합니다!`, 'success');
      await bootstrapAfterAuth();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function initialsFromName(name) {
  if (!name) return '?';
  const trimmed = String(name).trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function createMainLayout() {
  appRoot.innerHTML = `
    <div class="main-app">
      <header class="app-header card">
        <div class="profile">
          <div class="avatar" id="profile-avatar"></div>
          <div>
            <div class="name" id="profile-name"></div>
            <div class="meta" id="profile-meta"></div>
          </div>
        </div>
        <div class="header-actions">
          <button class="secondary" id="logout-button">로그아웃</button>
        </div>
      </header>
      <div class="layout">
        <aside class="sidebar">
          <section class="panel card">
            <h2 class="panel-title">부서 필터</h2>
            <p class="helper-text">표시할 부서를 선택하세요. 기본값은 전체입니다.</p>
            <div class="filter-group" id="department-filter"></div>
            <div class="section-divider"></div>
            <div class="helper-text" id="department-legend"></div>
          </section>
          <section class="panel card">
            <h2 class="panel-title">팀 맛집 목록</h2>
            <div id="restaurant-list" class="restaurant-list"></div>
          </section>
          <section class="panel card">
            <h2 class="panel-title">새 맛집 추가</h2>
            <form id="restaurant-form" class="form-grid">
              <div>
                <label>이름</label>
                <input name="name" required placeholder="상호명" />
              </div>
              <div>
                <label>주소</label>
                <input name="address" placeholder="도로명 주소" />
              </div>
              <div class="form-row">
                <div>
                  <label>위도</label>
                  <input name="lat" type="number" step="0.000001" required />
                </div>
                <div>
                  <label>경도</label>
                  <input name="lng" type="number" step="0.000001" required />
                </div>
              </div>
              <div>
                <label>카테고리</label>
                <input name="category" placeholder="예: 한식" />
              </div>
              <div>
                <label>메모</label>
                <textarea name="description" rows="3" placeholder="팀에게 공유할 정보"></textarea>
              </div>
              <button class="primary" type="submit">맛집 저장</button>
            </form>
          </section>
        </aside>
        <section class="map-section">
          <div class="map-wrapper card">
            <div id="map" class="map-container"></div>
            <div id="map-overlay" class="map-overlay"></div>
          </div>
          <section class="panel card">
            <div id="restaurant-detail"></div>
          </section>
        </section>
      </div>
    </div>
  `;

  ui.listContainer = document.getElementById('restaurant-list');
  ui.detailContainer = document.getElementById('restaurant-detail');
  ui.filterContainer = document.getElementById('department-filter');
  ui.filterLegend = document.getElementById('department-legend');
  ui.mapContainer = document.getElementById('map');
  ui.mapOverlay = document.getElementById('map-overlay');
  ui.addRestaurantForm = document.getElementById('restaurant-form');

  document.getElementById('logout-button').addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ignore logout failure
    }
    resetStateForLogout();
    createAuthView();
  });

  ui.addRestaurantForm.addEventListener('submit', handleRestaurantSubmit);

  updateProfileHeader();
  renderDepartmentFilter();
  renderRestaurantList();
  renderRestaurantDetail();
  initializeMap();
}

function updateProfileHeader() {
  const avatarEl = document.getElementById('profile-avatar');
  const nameEl = document.getElementById('profile-name');
  const metaEl = document.getElementById('profile-meta');
  if (!state.user) return;
  avatarEl.textContent = initialsFromName(state.user.displayName || state.user.username);
  avatarEl.style.background = '#312e81';
  avatarEl.style.color = '#fff';
  avatarEl.style.width = '48px';
  avatarEl.style.height = '48px';
  avatarEl.style.borderRadius = '14px';
  avatarEl.style.display = 'flex';
  avatarEl.style.alignItems = 'center';
  avatarEl.style.justifyContent = 'center';
  avatarEl.style.fontWeight = '700';
  nameEl.textContent = state.user.displayName || state.user.username;
  metaEl.textContent = `${state.user.department || '부서 미지정'} · 팀 코드 보유`;
}

function renderDepartmentFilter() {
  if (!ui.filterContainer) return;
  const uniqueDepartments = new Set(state.departments.concat(state.restaurants.flatMap(r => Object.keys(r.departments || {}))));
  if (!uniqueDepartments.size) {
    ui.filterContainer.innerHTML = '<span class="helper-text">등록된 부서가 없습니다.</span>';
    return;
  }
  ui.filterContainer.innerHTML = '';
  uniqueDepartments.forEach(dept => {
    const isActive = state.activeDepartments.size === 0 || state.activeDepartments.has(dept);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `filter-chip ${isActive ? 'active' : ''}`;
    chip.textContent = dept;
    const color = getDepartmentColor(dept);
    chip.style.borderColor = color;
    chip.style.background = isActive ? color : '#eff6ff';
    chip.style.color = isActive ? '#fff' : '#1e293b';
    chip.addEventListener('click', () => toggleDepartmentFilter(dept));
    ui.filterContainer.appendChild(chip);
  });
  renderDepartmentLegend(uniqueDepartments);
}

function renderDepartmentLegend(departments) {
  if (!ui.filterLegend) return;
  const legendHtml = Array.from(departments)
    .map(dept => {
      const color = getDepartmentColor(dept);
      return `<span class="department-badge"><span class="department-dot" style="background:${color}"></span>${dept}</span>`;
    })
    .join(' ');
  ui.filterLegend.innerHTML = legendHtml;
}

function toggleDepartmentFilter(department) {
  if (state.activeDepartments.has(department)) {
    state.activeDepartments.delete(department);
  } else {
    state.activeDepartments.add(department);
  }
  // if all departments selected, treat as show all (clear set)
  if (state.activeDepartments.size === 0) {
    // nothing to do
  }
  renderDepartmentFilter();
  renderRestaurantList();
  updateMapMarkers();
}

function filteredRestaurants() {
  if (!state.activeDepartments || state.activeDepartments.size === 0) {
    return state.restaurants;
  }
  return state.restaurants.filter(rest => {
    const departments = Object.keys(rest.departments || {});
    if (departments.length === 0) return false;
    return departments.some(dept => state.activeDepartments.has(dept));
  });
}

function renderRestaurantList() {
  if (!ui.listContainer) return;
  const restaurants = filteredRestaurants();
  if (!restaurants.length) {
    ui.listContainer.innerHTML = '<div class="empty-state">아직 등록된 맛집이 없거나 선택한 부서의 리뷰가 없습니다.</div>';
    return;
  }
  ui.listContainer.innerHTML = '';
  restaurants
    .sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0))
    .forEach(rest => {
      const card = document.createElement('article');
      card.className = `restaurant-card ${state.selectedRestaurantId === rest.id ? 'active' : ''}`;
      card.innerHTML = `
        <h3 class="title">${rest.name}</h3>
        <div class="meta">
          <span>${rest.category || '카테고리 미지정'}</span>
          <span>${rest.address || '주소 미등록'}</span>
        </div>
        <div class="meta" style="margin-top:8px; gap: 10px; align-items:center;">
          <span class="rating-badge">⭐ ${rest.averageRating || '평가 없음'} (${rest.reviewCount || 0})</span>
          ${renderDepartmentBadge(rest)}
        </div>
        ${rest.latestReview ? `<p class="helper-text" style="margin-top:10px;">최근 리뷰: [${rest.latestReview.department}] ${rest.latestReview.shortComment || rest.latestReview.comment || ''}</p>` : ''}
      `;
      card.addEventListener('click', () => selectRestaurant(rest.id));
      ui.listContainer.appendChild(card);
    });
}

function renderDepartmentBadge(rest) {
  const departments = Object.values(rest.departments || {});
  if (!departments.length) {
    return '<span class="helper-text">평가 대기</span>';
  }
  const top = departments.sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0))[0];
  const color = getDepartmentColor(top.department);
  return `<span class="department-badge"><span class="department-dot" style="background:${color}"></span>${top.department} · ${top.reviewCount}건</span>`;
}

async function selectRestaurant(restaurantId) {
  state.selectedRestaurantId = restaurantId;
  renderRestaurantList();
  try {
    await fetchRestaurantDetail(restaurantId);
    renderRestaurantDetail();
    focusMarker(restaurantId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderRestaurantDetail() {
  if (!ui.detailContainer) return;
  const detail = state.restaurantDetails[state.selectedRestaurantId];
  if (!detail) {
    ui.detailContainer.innerHTML = `
      <div class="empty-state">
        왼쪽 목록이나 지도의 마커를 클릭해 상세 정보를 확인하세요.
      </div>
    `;
    return;
  }
  const { restaurant, reviews } = detail;
  const departmentSummary = Object.values(restaurant.departments || {});
  ui.detailContainer.innerHTML = `
    <div class="detail-header">
      <h2>${restaurant.name}</h2>
      <div class="meta">
        <span>${restaurant.address || '주소 미등록'}</span>
        <span>${restaurant.category || '카테고리 미지정'}</span>
      </div>
      <div class="meta" style="gap:8px;">
        <span class="rating-badge">⭐ ${restaurant.averageRating || '평가 없음'} (${restaurant.reviewCount || 0} 리뷰)</span>
        ${departmentSummary
          .map(summary => {
            const color = getDepartmentColor(summary.department);
            return `<span class="department-badge"><span class="department-dot" style="background:${color}"></span>${summary.department} · ${summary.reviewCount}건 · ${summary.averageRating}점</span>`;
          })
          .join('')}
      </div>
    </div>
    <div class="section-divider"></div>
    <section>
      <h3>리뷰 작성</h3>
      <form id="review-form" class="form-grid">
        <div>
          <label>평점 (1~5)</label>
          <input name="rating" type="number" min="1" max="5" step="1" required />
        </div>
        <div>
          <label>한줄 코멘트</label>
          <input name="shortComment" maxlength="120" placeholder="팀원에게 전하고 싶은 한마디" />
        </div>
        <div>
          <label>상세 코멘트</label>
          <textarea name="comment" rows="3" maxlength="500" placeholder="자세한 후기를 남겨주세요."></textarea>
        </div>
        <button class="primary" type="submit">리뷰 저장</button>
      </form>
    </section>
    <div class="section-divider"></div>
    <section>
      <h3>팀 리뷰</h3>
      <div class="review-list">
        ${reviews.length === 0
          ? '<div class="empty-state">아직 작성된 리뷰가 없습니다.</div>'
          : reviews
              .map(review => {
                const color = getDepartmentColor(review.department);
                return `
                  <article class="review-card">
                    <div class="header">
                      <strong>${review.authorName}</strong>
                      <span class="rating-badge">⭐ ${review.rating}</span>
                    </div>
                    <div class="meta">${review.department}</div>
                    ${review.shortComment ? `<div class="comment">${review.shortComment}</div>` : ''}
                    ${review.comment ? `<div class="comment" style="color:#1e293b;">${review.comment}</div>` : ''}
                    <div class="helper-text">${new Date(review.createdAt).toLocaleString()}</div>
                  </article>
                `;
              })
              .join('')}
      </div>
    </section>
  `;
  ui.reviewForm = document.getElementById('review-form');
  ui.reviewForm.addEventListener('submit', handleReviewSubmit);
}

async function handleRestaurantSubmit(event) {
  event.preventDefault();
  const formData = new FormData(ui.addRestaurantForm);
  try {
    const payload = await apiFetch('/api/restaurants', {
      method: 'POST',
      body: JSON.stringify({
        name: formData.get('name'),
        address: formData.get('address'),
        lat: formData.get('lat'),
        lng: formData.get('lng'),
        category: formData.get('category'),
        description: formData.get('description')
      })
    });
    showToast('맛집이 저장되었습니다.', 'success');
    ui.addRestaurantForm.reset();
    await fetchRestaurants();
    renderDepartmentFilter();
    renderRestaurantList();
    updateMapMarkers();
    await selectRestaurant(payload.restaurant.id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleReviewSubmit(event) {
  event.preventDefault();
  if (!state.selectedRestaurantId) return;
  const formData = new FormData(ui.reviewForm);
  try {
    const payload = await apiFetch(`/api/restaurants/${state.selectedRestaurantId}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        rating: formData.get('rating'),
        shortComment: formData.get('shortComment'),
        comment: formData.get('comment')
      })
    });
    showToast('리뷰가 등록되었습니다.', 'success');
    ui.reviewForm.reset();
    state.restaurantDetails[state.selectedRestaurantId] = {
      restaurant: payload.restaurant,
      reviews: [payload.review, ...state.restaurantDetails[state.selectedRestaurantId].reviews]
    };
    await fetchRestaurants();
    renderDepartmentFilter();
    renderRestaurantList();
    renderRestaurantDetail();
    updateMapMarkers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function getDepartmentColor(department) {
  if (departmentColors[department]) {
    return departmentColors[department];
  }
  const hash = Array.from(department).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue = hash % 360;
  const color = `hsl(${hue}, 70%, 55%)`;
  departmentColors[department] = color;
  return color;
}

function initializeMap() {
  if (!ui.mapContainer) return;
  if (!config.kakaoMapKey) {
    ui.mapOverlay.innerHTML = `
      <div class="empty-state">
        <strong>카카오맵 API 키를 설정하세요.</strong><br />
        frontend/config.js 파일의 <code>kakaoMapKey</code> 값을 입력하면 지도가 표시됩니다.
      </div>
    `;
    ui.mapOverlay.style.display = 'flex';
    ui.mapOverlay.style.alignItems = 'center';
    ui.mapOverlay.style.justifyContent = 'center';
    ui.mapOverlay.style.position = 'absolute';
    ui.mapOverlay.style.inset = '0';
    ui.mapOverlay.style.background = 'rgba(248, 250, 252, 0.92)';
    return;
  }
  loadKakaoMaps(config.kakaoMapKey)
    .then(() => {
      state.mapReady = true;
      if (!state.map) {
        const center = new kakao.maps.LatLng(37.5665, 126.978);
        state.map = new kakao.maps.Map(ui.mapContainer, {
          center,
          level: 4
        });
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(position => {
            const { latitude, longitude } = position.coords;
            state.map.setCenter(new kakao.maps.LatLng(latitude, longitude));
          });
        }
      }
      ui.mapOverlay.innerHTML = '';
      ui.mapOverlay.style.display = 'none';
      updateMapMarkers();
    })
    .catch(() => {
      ui.mapOverlay.innerHTML = `
        <div class="empty-state">
          지도를 불러오지 못했습니다. API 키를 확인해주세요.
        </div>
      `;
      ui.mapOverlay.style.display = 'flex';
    });
}

function loadKakaoMaps(appKey) {
  return new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps) {
      window.kakao.maps.load(() => resolve(window.kakao.maps));
      return;
    }
    const existingScript = document.getElementById('kakao-maps-sdk');
    if (existingScript) {
      existingScript.addEventListener('load', () => {
        window.kakao.maps.load(() => resolve(window.kakao.maps));
      });
      existingScript.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.id = 'kakao-maps-sdk';
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&appkey=${appKey}`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window.kakao.maps.load(() => resolve(window.kakao.maps));
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function updateMapMarkers() {
  if (!state.mapReady || !state.map) return;
  state.markers.forEach(marker => marker.setMap(null));
  state.markers = [];
  const bounds = new kakao.maps.LatLngBounds();
  const restaurants = filteredRestaurants();
  if (restaurants.length === 0) {
    return;
  }
  restaurants.forEach(rest => {
    if (!rest.lat || !rest.lng) return;
    const position = new kakao.maps.LatLng(rest.lat, rest.lng);
    bounds.extend(position);
    const marker = new kakao.maps.Marker({
      map: state.map,
      position,
      image: createMarkerImageForRestaurant(rest)
    });
    kakao.maps.event.addListener(marker, 'click', () => selectRestaurant(rest.id));
    state.markers.push(marker);
  });
  if (!bounds.isEmpty()) {
    state.map.setBounds(bounds);
  }
}

function focusMarker(restaurantId) {
  if (!state.mapReady || !state.map) return;
  const restaurant = state.restaurants.find(r => r.id === restaurantId);
  if (!restaurant) return;
  const position = new kakao.maps.LatLng(restaurant.lat, restaurant.lng);
  state.map.panTo(position);
}

function createMarkerImage(color) {
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="${color}" stroke="white" stroke-width="3"/><circle cx="16" cy="16" r="5" fill="white" opacity="0.4"/></svg>`;
  return createMarkerImageFromSvg(svg);
}

function createMarkerImageForRestaurant(rest) {
  const departmentSummary = Object.values(rest.departments || {}).filter(bucket => bucket.reviewCount > 0);
  if (departmentSummary.length === 0) {
    const fallbackColor = rest.latestReview
      ? getDepartmentColor(rest.latestReview.department)
      : getDepartmentColor('기타');
    return createMarkerImage(fallbackColor);
  }
  if (departmentSummary.length === 1) {
    return createMarkerImage(getDepartmentColor(departmentSummary[0].department));
  }
  const totalReviews = departmentSummary.reduce((sum, bucket) => sum + bucket.reviewCount, 0);
  if (!totalReviews) {
    return createMarkerImage(getDepartmentColor('기타'));
  }
  const segments = [];
  const startBase = -Math.PI / 2;
  let currentAngle = startBase;
  const sorted = departmentSummary.sort((a, b) => b.reviewCount - a.reviewCount);
  sorted.forEach((bucket, index) => {
    if (bucket.reviewCount <= 0) return;
    const ratio = bucket.reviewCount / totalReviews;
    const startAngle = currentAngle;
    let endAngle = currentAngle + ratio * Math.PI * 2;
    if (index === sorted.length - 1) {
      endAngle = startBase + Math.PI * 2;
    }
    segments.push({
      startAngle,
      endAngle,
      color: getDepartmentColor(bucket.department)
    });
    currentAngle = endAngle;
  });
  const svg = createSegmentedMarkerSvg(segments);
  return createMarkerImageFromSvg(svg);
}

function createSegmentedMarkerSvg(segments) {
  const size = 32;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 10;
  const innerRadius = 5;
  const sectorPaths = segments
    .map(segment => {
      const path = describeSector(cx, cy, radius, segment.startAngle, segment.endAngle);
      return `<path d="${path}" fill="${segment.color}" stroke="white" stroke-width="1.5"/>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${sectorPaths}<circle cx="${cx}" cy="${cy}" r="${innerRadius}" fill="white" opacity="0.5"/></svg>`;
}

function describeSector(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

function polarToCartesian(cx, cy, radius, angleInRadians) {
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians)
  };
}

function createMarkerImageFromSvg(svg) {
  const size = new kakao.maps.Size(32, 32);
  const encoded = window.btoa(svg);
  return new kakao.maps.MarkerImage(`data:image/svg+xml;base64,${encoded}`, size, {
    offset: new kakao.maps.Point(16, 32)
  });
}

async function bootstrapAfterAuth() {
  await Promise.all([fetchCurrentUser(), fetchDepartments(), fetchRestaurants()]);
  createMainLayout();
}

async function bootstrap() {
  if (!state.token) {
    createAuthView();
    return;
  }
  try {
    await bootstrapAfterAuth();
  } catch (err) {
    console.error(err);
    resetStateForLogout();
    createAuthView();
  }
}

bootstrap();
