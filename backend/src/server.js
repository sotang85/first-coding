const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const DATA_PATH = path.join(__dirname, '..', 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'frontend');
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const sessions = new Map();
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY || '';

const DEFAULT_TEAM_DEPARTMENT_CODES = [
  { department: '경영기획', code: '1001' },
  { department: '고객사업', code: '1002' },
  { department: '브랜드상품전략', code: '1003' },
  { department: '마케팅', code: '1004' },
  { department: '경영지원', code: '1005' }
];

const DEFAULT_TEAMS = [
  {
    id: 'team-default',
    name: 'Vibe Coding Lab',
    code: 'VIBE-TEAM',
    description: '기본 팀 코드입니다. 환경설정에서 수정하세요.',
    departmentCodes: DEFAULT_TEAM_DEPARTMENT_CODES,
    departments: DEFAULT_TEAM_DEPARTMENT_CODES.map(entry => entry.department)
  }
];

function ensureDataFile() {
  if (!fs.existsSync(DATA_PATH)) {
    const initial = {
      teams: DEFAULT_TEAMS,
      users: [],
      restaurants: [],
      reviews: []
    };
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readDatabase() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);
  const mutated = seedDatabaseIfNeeded(data);
  if (mutated) {
    writeDatabase(data);
  }
  return data;
}

function writeDatabase(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function fetchKakaoPlaces({ lat, lng, radius }) {
  return new Promise((resolve, reject) => {
    if (!KAKAO_REST_API_KEY) {
      reject(new Error('카카오 REST API 키가 설정되지 않았습니다.'));
      return;
    }
    const params = new URLSearchParams({
      category_group_code: 'FD6',
      x: String(lng),
      y: String(lat),
      radius: String(radius),
      size: '15',
      sort: 'distance'
    });

    const requestOptions = {
      hostname: 'dapi.kakao.com',
      path: `/v2/local/search/category.json?${params.toString()}`,
      method: 'GET',
      headers: {
        Authorization: `KakaoAK ${KAKAO_REST_API_KEY}`
      }
    };

    const request = https.request(requestOptions, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1e6) {
          response.destroy();
          reject(new Error('Kakao API 응답이 너무 큽니다.'));
          return;
        }
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Kakao API 호출 실패(${response.statusCode})`));
          return;
        }
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (error) {
          reject(new Error('Kakao API 응답을 해석할 수 없습니다.'));
        }
      });
    });

    request.on('error', reject);
    request.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(data);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const iterations = 310000;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return { salt, hash, iterations };
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const { salt, hash, iterations } = stored;
  const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifyHash, 'hex'));
}

function seedDatabaseIfNeeded(db) {
  let mutated = false;

  if (!Array.isArray(db.teams)) {
    db.teams = [];
    mutated = true;
  }

  const defaultTeamTemplate = DEFAULT_TEAMS[0];
  let defaultTeam = db.teams.find(team => team.code === defaultTeamTemplate.code);
  if (!defaultTeam) {
    defaultTeam = { ...defaultTeamTemplate };
    db.teams.push(defaultTeam);
    mutated = true;
  } else {
    const desiredDepartmentCodes = (defaultTeamTemplate.departmentCodes || []).map(entry => ({ ...entry }));
    const desiredDepartments = desiredDepartmentCodes.map(entry => entry.department);
    if (
      !Array.isArray(defaultTeam.departmentCodes) ||
      desiredDepartmentCodes.length !== defaultTeam.departmentCodes.length ||
      desiredDepartmentCodes.some((entry, index) => {
        const target = defaultTeam.departmentCodes[index];
        if (!target) return true;
        return target.department !== entry.department || target.code !== entry.code;
      })
    ) {
      defaultTeam.departmentCodes = desiredDepartmentCodes;
      mutated = true;
    }
    if (
      !Array.isArray(defaultTeam.departments) ||
      desiredDepartments.length !== defaultTeam.departments.length ||
      desiredDepartments.some((dept, index) => defaultTeam.departments[index] !== dept)
    ) {
      defaultTeam.departments = desiredDepartments.slice();
      mutated = true;
    }
  }

  if (!Array.isArray(db.users)) {
    db.users = [];
    mutated = true;
  }
  if (!Array.isArray(db.restaurants)) {
    db.restaurants = [];
    mutated = true;
  }
  if (!Array.isArray(db.reviews)) {
    db.reviews = [];
    mutated = true;
  }

  if (!defaultTeam) {
    return mutated;
  }

  const hasRestaurantWithCoords = db.restaurants.some(rest => {
    if (!rest) return false;
    const lat = Number(rest.lat);
    const lng = Number(rest.lng);
    return Number.isFinite(lat) && Number.isFinite(lng);
  });

  if (hasRestaurantWithCoords) {
    return mutated;
  }

  const { user: seedUser, mutated: userMutated } = ensureSeedUser(db, defaultTeam.id);
  if (userMutated) {
    mutated = true;
  }

  const restaurantId = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.restaurants.push({
    id: restaurantId,
    teamId: defaultTeam.id,
    name: '바이브 라운지 분식',
    address: '서울특별시 강남구 테헤란로 427 위워크 지하 1층',
    lat: 37.498025,
    lng: 127.027705,
    category: '분식',
    description: '팀 실습용으로 기본 제공되는 예시 맛집입니다.',
    createdBy: seedUser.id,
    createdAt
  });

  db.reviews.push({
    id: crypto.randomUUID(),
    restaurantId,
    userId: seedUser.id,
    rating: 5,
    shortComment: '떡볶이가 일품!',
    comment: '카카오맵 마커와 정보창이 정상 동작하는지 확인할 수 있는 기본 리뷰입니다.',
    createdAt
  });

  return true;
}

function ensureSeedUser(db, teamId) {
  const username = 'vibe-sample';
  const existing = db.users.find(user => user.username === username && user.teamId === teamId);
  if (existing) {
    return { user: existing, mutated: false };
  }
  const team = db.teams.find(t => t.id === teamId);
  const departmentEntry = team && Array.isArray(team.departmentCodes) ? team.departmentCodes[0] : null;
  const departmentName = departmentEntry ? departmentEntry.department : '경영기획';
  const departmentCode = departmentEntry ? departmentEntry.code : null;
  const userId = crypto.randomUUID();
  const passwordRecord = hashPassword(crypto.randomBytes(12).toString('hex'));
  const now = new Date().toISOString();
  const user = {
    id: userId,
    username,
    displayName: '바이브 샘플',
    department: departmentName,
    departmentCode,
    teamId,
    createdAt: now,
    password: passwordRecord
  };
  db.users.push(user);
  return { user, mutated: true };
}

function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const record = sessions.get(token);
  if (!record) return null;
  if (Date.now() - record.createdAt > TOKEN_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return record;
}

function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  return getSession(token);
}

function requireAuth(req, res) {
  const session = authenticate(req);
  if (!session) {
    sendJson(res, 401, { message: '인증이 필요합니다.' });
    return null;
  }
  return session;
}

function sanitizeUser(user) {
  const { password, ...rest } = user;
  return rest;
}

function calculateRestaurantSummary(db, restaurant) {
  const reviews = db.reviews.filter(r => r.restaurantId === restaurant.id);
  const users = new Map(db.users.map(u => [u.id, u]));
  const overall = {
    reviewCount: reviews.length,
    averageRating: reviews.length
      ? Number((reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(2))
      : 0
  };

  const departments = {};
  for (const review of reviews) {
    const user = users.get(review.userId);
    const department = (user && user.department) || '기타';
    if (!departments[department]) {
      departments[department] = {
        department,
        reviewCount: 0,
        averageRating: 0,
        latestReview: null
      };
    }
    const bucket = departments[department];
    bucket.reviewCount += 1;
    bucket.averageRating += review.rating || 0;
    if (!bucket.latestReview || new Date(bucket.latestReview.createdAt) < new Date(review.createdAt)) {
      bucket.latestReview = {
        rating: review.rating,
        shortComment: review.shortComment,
        comment: review.comment,
        createdAt: review.createdAt,
        authorName: user ? user.displayName : '알 수 없음'
      };
    }
  }
  for (const key of Object.keys(departments)) {
    const bucket = departments[key];
    bucket.averageRating = Number((bucket.averageRating / bucket.reviewCount).toFixed(2));
  }

  let latestReview = null;
  if (reviews.length > 0) {
    latestReview = reviews
      .map(review => {
        const author = users.get(review.userId);
        return {
          id: review.id,
          rating: review.rating,
          shortComment: review.shortComment,
          comment: review.comment,
          createdAt: review.createdAt,
          department: author ? author.department : '기타',
          authorName: author ? author.displayName : '알 수 없음'
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  }

  return {
    ...restaurant,
    ...overall,
    departments,
    latestReview
  };
}

function getRequestBody(req) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    return parseBody(req);
  }
  return Promise.resolve({});
}

function serveStaticFile(req, res, pathname) {
  const baseDir = path.resolve(PUBLIC_DIR);
  if (!fs.existsSync(baseDir)) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const sanitizedPath = pathname.replace(/^\/+/, '');
  let filePath = path.resolve(path.join(baseDir, sanitizedPath));
  if (!filePath.startsWith(baseDir)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  fs.createReadStream(filePath)
    .on('error', () => sendText(res, 500, 'Internal Server Error'))
    .once('open', () => {
      res.writeHead(200, { 'Content-Type': contentType });
    })
    .pipe(res);
}

function handleAuthRoutes(req, res, pathname, db) {
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const { username, password, departmentCode, displayName, department } = body;
        if (!username || !password || !departmentCode) {
          sendJson(res, 400, { message: '아이디, 비밀번호, 부서 코드는 필수입니다.' });
          return;
        }
        const normalizedCode = String(departmentCode).trim();
        if (!normalizedCode) {
          sendJson(res, 400, { message: '부서 코드를 입력해주세요.' });
          return;
        }
        const team = db.teams.find(
          t => Array.isArray(t.departmentCodes) && t.departmentCodes.some(entry => entry.code === normalizedCode)
        );
        if (!team) {
          sendJson(res, 400, { message: '유효하지 않은 부서 코드입니다.' });
          return;
        }
        const matchedDepartment = team.departmentCodes.find(entry => entry.code === normalizedCode);
        if (!matchedDepartment) {
          sendJson(res, 400, { message: '유효하지 않은 부서 코드입니다.' });
          return;
        }
        const normalizedUsername = String(username).trim().toLowerCase();
        if (db.users.some(u => u.username === normalizedUsername)) {
          sendJson(res, 409, { message: '이미 사용 중인 아이디입니다.' });
          return;
        }
        const passwordRecord = hashPassword(password);
        const user = {
          id: crypto.randomUUID(),
          username: normalizedUsername,
          displayName: displayName ? String(displayName).trim() : normalizedUsername,
          department: matchedDepartment.department || department || '기타',
          departmentCode: matchedDepartment.code,
          teamId: team.id,
          createdAt: new Date().toISOString(),
          password: passwordRecord
        };
        db.users.push(user);
        writeDatabase(db);
        const token = createToken(user.id);
        sendJson(res, 201, { token, user: sanitizeUser(user) });
      })
      .catch(err => {
        sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' });
      });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const { username, password } = body;
        if (!username || !password) {
          sendJson(res, 400, { message: '아이디와 비밀번호를 입력하세요.' });
          return;
        }
        const normalizedUsername = String(username).trim().toLowerCase();
        const user = db.users.find(u => u.username === normalizedUsername);
        if (!user || !verifyPassword(password, user.password)) {
          sendJson(res, 401, { message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
          return;
        }
        const token = createToken(user.id);
        sendJson(res, 200, { token, user: sanitizeUser(user) });
      })
      .catch(err => sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' }));
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const session = requireAuth(req, res);
    if (!session) return;
    const user = db.users.find(u => u.id === session.userId);
    if (!user) {
      sendJson(res, 401, { message: '세션이 만료되었습니다.' });
      return;
    }
    sendJson(res, 200, { user: sanitizeUser(user) });
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const session = authenticate(req);
    if (session) {
      const authHeader = req.headers['authorization'];
      const token = authHeader.slice(7);
      sessions.delete(token);
    }
    sendJson(res, 200, { message: '로그아웃 되었습니다.' });
    return;
  }

  return false;
}

function handleMetaRoutes(req, res, pathname, db) {
  if (pathname === '/api/meta/departments' && req.method === 'GET') {
    const departments = db.teams.flatMap(team => {
      if (!Array.isArray(team.departmentCodes)) {
        const fallback = Array.isArray(team.departments) ? team.departments : [];
        return fallback.map(name => ({ name, code: null, teamId: team.id, teamName: team.name }));
      }
      return team.departmentCodes.map(entry => ({
        name: entry.department,
        code: entry.code,
        teamId: team.id,
        teamName: team.name
      }));
    });
    sendJson(res, 200, { departments });
    return true;
  }
  if (pathname === '/api/meta/teams' && req.method === 'GET') {
    const publicTeams = db.teams.map(team => ({
      id: team.id,
      name: team.name,
      description: team.description,
      departments: team.departments,
      departmentCodes: team.departmentCodes || []
    }));
    sendJson(res, 200, { teams: publicTeams });
    return true;
  }
  return false;
}

function normalizeKakaoPlace(document) {
  if (!document) {
    return null;
  }
  const lat = Number(document.y);
  const lng = Number(document.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  const categoryRaw = typeof document.category_name === 'string' ? document.category_name : '';
  const categoryDepth = categoryRaw
    .split('>')
    .map(token => token.trim())
    .filter(Boolean)
    .pop() || '';
  const distance = document.distance !== undefined ? Number(document.distance) : null;
  return {
    id: document.id,
    name: document.place_name || '',
    category: categoryRaw,
    categoryDepth,
    phone: document.phone || '',
    address: document.address_name || '',
    roadAddress: document.road_address_name || '',
    url: document.place_url || '',
    lat,
    lng,
    distance: Number.isFinite(distance) ? distance : null
  };
}

function clampRadius(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1000;
  }
  if (numeric < 10) return 10;
  if (numeric > 20000) return 20000;
  return Math.round(numeric);
}

function handleExternalRoutes(req, res, pathname, db) {
  if (pathname !== '/api/external/places' || req.method !== 'GET') {
    return false;
  }
  const session = requireAuth(req, res);
  if (!session) return true;
  const user = db.users.find(u => u.id === session.userId);
  if (!user) {
    sendJson(res, 401, { message: '사용자 정보를 찾을 수 없습니다.' });
    return true;
  }
  const parsedUrl = url.parse(req.url, true);
  const { lat, lng, radius } = parsedUrl.query || {};
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    sendJson(res, 400, { message: '위도와 경도 값을 확인해주세요.' });
    return true;
  }
  const searchRadius = clampRadius(radius);
  fetchKakaoPlaces({ lat: latitude, lng: longitude, radius: searchRadius })
    .then(result => {
      const documents = Array.isArray(result && result.documents) ? result.documents : [];
      const places = documents.map(normalizeKakaoPlace).filter(Boolean);
      const totalCount = result && result.meta && typeof result.meta.total_count === 'number'
        ? result.meta.total_count
        : places.length;
      sendJson(res, 200, { places, meta: { totalCount } });
    })
    .catch(error => {
      console.error('Kakao Places API error:', error);
      const message = error && error.message ? error.message : '외부 장소를 불러오지 못했습니다.';
      const status = message.includes('키') ? 500 : 502;
      sendJson(res, status, { message });
    });
  return true;
}

function handleRestaurantRoutes(req, res, pathname, db) {
  if (!pathname.startsWith('/api/restaurants')) {
    return false;
  }
  const session = requireAuth(req, res);
  if (!session) return true;
  const user = db.users.find(u => u.id === session.userId);
  if (!user) {
    sendJson(res, 401, { message: '사용자 정보를 찾을 수 없습니다.' });
    return true;
  }
  const teamId = user.teamId;
  const parsedUrl = url.parse(req.url, true);

  if (pathname === '/api/restaurants' && req.method === 'GET') {
    const list = db.restaurants
      .filter(rest => rest.teamId === teamId)
      .map(rest => calculateRestaurantSummary(db, rest));
    sendJson(res, 200, { restaurants: list });
    return true;
  }

  if (pathname === '/api/restaurants' && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const { name, address, lat, lng, category, description } = body;
        const normalizedName = typeof name === 'string' ? name.trim() : '';
        const latProvided = lat !== undefined && lat !== null && String(lat).trim() !== '';
        const lngProvided = lng !== undefined && lng !== null && String(lng).trim() !== '';
        const latitude = Number(lat);
        const longitude = Number(lng);
        if (
          !normalizedName ||
          !latProvided ||
          !lngProvided ||
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          latitude < -90 ||
          latitude > 90 ||
          longitude < -180 ||
          longitude > 180
        ) {
          sendJson(res, 400, { message: '이름과 위도/경도 값을 확인해주세요. 위도는 -90~90, 경도는 -180~180 범위여야 합니다.' });
          return;
        }
        const restaurant = {
          id: crypto.randomUUID(),
          teamId,
          name: normalizedName,
          address: address ? String(address).trim() : '',
          lat: latitude,
          lng: longitude,
          category: category ? String(category).trim() : '',
          description: description ? String(description).trim() : '',
          createdBy: user.id,
          createdAt: new Date().toISOString()
        };
        db.restaurants.push(restaurant);
        writeDatabase(db);
        sendJson(res, 201, { restaurant: calculateRestaurantSummary(db, restaurant) });
      })
      .catch(err => sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' }));
  }

  const restaurantMatch = pathname.match(/^\/api\/restaurants\/([^/]+)$/);
  if (restaurantMatch) {

    const restaurantId = restaurantMatch[1];
    const restaurant = db.restaurants.find(r => r.id === restaurantId && r.teamId === teamId);
    if (!restaurant) {
      sendJson(res, 404, { message: '맛집을 찾을 수 없습니다.' });
      return true;
    }
    if (req.method === 'GET') {
      const users = new Map(db.users.map(u => [u.id, u]));
      const reviews = db.reviews
        .filter(r => r.restaurantId === restaurantId)
        .map(review => {
          const reviewer = users.get(review.userId);
          return {
            id: review.id,
            rating: review.rating,
            shortComment: review.shortComment,
            comment: review.comment,
            createdAt: review.createdAt,
            authorId: review.userId,
            authorName: reviewer ? reviewer.displayName : '알 수 없음',
            department: reviewer ? reviewer.department : '기타'
          };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const payload = {
        restaurant: calculateRestaurantSummary(db, restaurant),
        reviews
      };
      sendJson(res, 200, payload);
      return true;
    }
    if (req.method === 'DELETE') {
      if (restaurant.createdBy !== user.id) {
        sendJson(res, 403, { message: '본인이 등록한 맛집만 삭제할 수 있습니다.' });
        return true;
      }
      db.restaurants = db.restaurants.filter(r => r.id !== restaurantId);
      db.reviews = db.reviews.filter(r => r.restaurantId !== restaurantId);
      writeDatabase(db);
      sendJson(res, 200, { message: '맛집을 삭제했습니다.', restaurantId });
      return true;
    }

  }

  const reviewMatch = pathname.match(/^\/api\/restaurants\/([^/]+)\/reviews$/);
  if (reviewMatch && req.method === 'POST') {
    return getRequestBody(req)
      .then(body => {
        const restaurantId = reviewMatch[1];
        const restaurant = db.restaurants.find(r => r.id === restaurantId && r.teamId === teamId);
        if (!restaurant) {
          sendJson(res, 404, { message: '맛집을 찾을 수 없습니다.' });
          return;
        }
        const { rating, shortComment, comment } = body;
        const numericRating = Number(rating);
        if (!numericRating || numericRating < 1 || numericRating > 5) {
          sendJson(res, 400, { message: '평점은 1에서 5 사이의 숫자여야 합니다.' });
          return;
        }
        const review = {
          id: crypto.randomUUID(),
          restaurantId,
          userId: user.id,
          rating: numericRating,
          shortComment: shortComment ? String(shortComment).slice(0, 120) : '',
          comment: comment ? String(comment).slice(0, 2000) : '',
          createdAt: new Date().toISOString()
        };
        db.reviews.push(review);
        writeDatabase(db);
        const users = new Map(db.users.map(u => [u.id, u]));
        const reviewer = users.get(user.id);
        sendJson(res, 201, {
          review: {
            id: review.id,
            rating: review.rating,
            shortComment: review.shortComment,
            comment: review.comment,
            createdAt: review.createdAt,
            authorId: reviewer ? reviewer.id : user.id,
            authorName: reviewer ? reviewer.displayName : '나',
            department: reviewer ? reviewer.department : '기타'
          },
          restaurant: calculateRestaurantSummary(db, restaurant)
        });
      })
      .catch(err => sendJson(res, 400, { message: err.message || '잘못된 요청입니다.' }));
  }

  const reviewDeleteMatch = pathname.match(/^\/api\/restaurants\/([^/]+)\/reviews\/([^/]+)$/);
  if (reviewDeleteMatch && req.method === 'DELETE') {
    const restaurantId = reviewDeleteMatch[1];
    const reviewId = reviewDeleteMatch[2];
    const restaurant = db.restaurants.find(r => r.id === restaurantId && r.teamId === teamId);
    if (!restaurant) {
      sendJson(res, 404, { message: '맛집을 찾을 수 없습니다.' });
      return true;
    }
    const review = db.reviews.find(r => r.id === reviewId && r.restaurantId === restaurantId);
    if (!review) {
      sendJson(res, 404, { message: '리뷰를 찾을 수 없습니다.' });
      return true;
    }
    if (review.userId !== user.id) {
      sendJson(res, 403, { message: '본인이 작성한 리뷰만 삭제할 수 있습니다.' });
      return true;
    }
    db.reviews = db.reviews.filter(r => r.id !== reviewId);
    writeDatabase(db);
    sendJson(res, 200, {
      message: '리뷰를 삭제했습니다.',
      reviewId,
      restaurant: calculateRestaurantSummary(db, restaurant)
    });
    return true;
  }


  return true;
}

const server = http.createServer((req, res) => {
  try {
    const parsedUrl = url.parse(req.url, true);
    let pathname = parsedUrl.pathname || '/';

    // remove trailing slash except root
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }

    const db = readDatabase();

    // API Routes
    if (pathname.startsWith('/api/')) {
      if (handleAuthRoutes(req, res, pathname, db) !== false) return;
      if (handleMetaRoutes(req, res, pathname, db)) return;
      if (handleExternalRoutes(req, res, pathname, db)) return;
      if (handleRestaurantRoutes(req, res, pathname, db)) return;
      sendJson(res, 404, { message: '요청한 API를 찾을 수 없습니다.' });
      return;
    }

    // Static assets
    if (req.method === 'GET') {
      const staticPath = pathname === '/' ? '/index.html' : pathname;
      try {
        serveStaticFile(req, res, staticPath);
      } catch (err) {
        console.error('Static file error:', err);
        sendText(res, 500, 'Internal Server Error');
      }
      return;
    }

    sendText(res, 405, 'Method Not Allowed');
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { message: '서버 오류가 발생했습니다.' });
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
