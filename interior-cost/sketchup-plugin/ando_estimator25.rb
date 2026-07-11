require 'sketchup.rb'
require 'fileutils'

module AndoEstimator25
  VERSION = '1.2.0' # (v1.2) 자재 코드([WD-####] 등) 집계 + DLP-TAKEOFF v2(material_code). 기존 aa_ 출력은 100% 동일 유지

  # (v1.2) 자재 코드 태그 — material-research SKM/로더가 머티리얼·컴포넌트 이름에 넣는 [코드]
  #   예: "[WD-0012] 구정마루 …", "[PT:DE:DEW340] 던에드워드 …". aa_ 이름은 레거시 패스 소유라 제외.
  MAT_CODE_RE = /\[([A-Z]{2,4}[-:][A-Za-z0-9:._\-]+)\]/

  # ========================
  # 헬퍼
  # ========================

  # DC dict 값 읽기(문자열이면 trim)
  def self._read_dc_attr(obj, key)
    v = obj.get_attribute('dynamic_attributes', key)
    v.is_a?(String) ? v.strip : v
  end

  # 인스턴스의 '로컬 X축 방향' 실제 길이(m)
  # (aa_len_에서 LenX가 없어도 길이 산출)
  def self._lenx_m_by_projection(inst, length_scale)
    v = inst.get_attribute('dynamic_attributes', 'lenx')
    return v.to_f * length_scale if v && v.to_f > 0.0

    t  = inst.transformation
    xu = t.xaxis
    return 0.0 if xu.length == 0.0
    xu = xu.clone; xu.normalize!

    bb = inst.definition.bounds
    smin = smax = nil
    8.times do |i|
      p = bb.corner(i).transform(t)
      s = p.x * xu.x + p.y * xu.y + p.z * xu.z
      smin = s if smin.nil? || s < smin
      smax = s if smax.nil? || s > smax
    end
    ((smax || 0.0) - (smin || 0.0)) * length_scale
  end

  # LenY를 cm로 안전하게 변환
  # - "11 cm" → 11 / "110 mm" → 11 / 4.33(인치) → 11
  # - 값이 없으면 실제 두께(바운딩박스*스케일) 사용
  def self._leny_to_cm(inst)
    defn = inst.definition
    raw = inst.get_attribute('dynamic_attributes','leny')
    if raw.is_a?(String)
      s = raw.strip.downcase
      if s.include?('cm');  return s.to_f
      elsif s.include?('mm'); return s.to_f / 10.0
      else; return s.to_f * 2.54 end
    elsif raw
      return raw.to_f * 2.54
    end
    (defn.bounds.depth * inst.transformation.yscale.abs) * 2.54
  end

  # LenY(cm) → 스펙 라벨(4/5/5.5/11cm)
  def self._intwall_spec_from_leny(inst)
    cm = _leny_to_cm(inst)
    candidates = {
      4.0  => '□30*30+석고1P',
      5.0  => '□30*30+석고2P',
      5.5  => '□30*30+석고2P+합판5T',
      11.0 => '□30*70+석고2P양면'
    }
    nearest = candidates.keys.min_by { |v| (cm - v).abs }
    return candidates[nearest] if (cm - nearest).abs <= 0.8
    ''
  end

  # INTwall 스펙 문자열 복원:
  # ① LenY(cm) 매핑 → ② '벽두께/spec' → ③ 옵션 인덱스 복원 → ④ dict 스캔
  def self._intwall_spec_string(inst)
    defn = inst.definition

    s = _intwall_spec_from_leny(inst)
    return s unless s.empty?

    %w[벽두께 spec].each do |k|
      v = _read_dc_attr(inst, k) || _read_dc_attr(defn, k)
      return v.to_s unless v.nil? || v.to_s.empty?
    end

    %w[벽두께 spec leny LenY].each do |k|
      sel  = _read_dc_attr(inst, k)  || _read_dc_attr(defn, k)
      opts = _read_dc_attr(inst, "#{k}_options") || _read_dc_attr(defn, "#{k}_options")
      next if sel.nil? || opts.nil?
      tokens = opts.to_s.split(/[|,;]+/).map(&:strip).reject(&:empty?)
      if sel.to_s =~ /^\d+$/
        i = sel.to_i
        return tokens[i] if i >= 0 && i < tokens.size
      else
        cand = tokens.find { |t| t.include?(sel.to_s) }
        return cand if cand
      end
    end

    [inst, defn].each do |obj|
      d = obj.attribute_dictionary('dynamic_attributes', false)
      next unless d
      (d.keys rescue []).each do |k|
        v = _read_dc_attr(obj, k)
        next unless v.is_a?(String)
        str = v.strip
        return str if str =~ /(석고\d+P|합판\d+T|30\*30|30\*70|양면)/
      end
    end

    ''
  end

  # 스펙 파서 → 구조재/보드 파라미터
  def self.parse_intwall_spec(spec_str)
    s = (spec_str || '').to_s.tr('×xX', '*')
    lumber   = s.include?('30*70') ? '투바이' : '다루끼'
    g_layers = (s[/석고(\d+)P/i, 1] || '1').to_i
    g_sides  = s.include?('양면') ? 2 : 1
    ply_t    = (s[/합판(\d+)T/i, 1] || '0').to_i
    {
      lumber:     lumber,              # '다루끼' / '투바이'
      g_layers:   g_layers,            # 석고 겹수
      g_sides:    g_sides,             # 1 or 2
      ply_thick:  ply_t,               # 0 or 5 …
      ply_layers: ply_t > 0 ? 1 : 0    # 합판(단면 1겹)
    }
  end

  # 인스턴스의 "뒷면(XZ)" 후보 세트 2개(maxY, minY) 중
  # - 각 세트의 총 면적을 구하고,
  # - 더 큰 세트를 채택하여 (면적, 내부루프둘레, W, H)를 반환
  def self._pick_back_face_set_and_spans(inst, area_scale, length_scale)
    defn = inst.definition
    t    = inst.transformation
    tol  = 0.001

    y_min = defn.bounds.min.y
    y_max = defn.bounds.max.y

    sets = []
    [[y_max, :max], [y_min, :min]].each do |yplane, tag|
      faces = defn.entities.grep(Sketchup::Face).select do |f|
        f.vertices.all? { |v| (v.position.y - yplane).abs <= tol }
      end
      next if faces.empty?

      # 면적 합
      a_in2 = faces.inject(0.0) { |s, f| s + f.area(t) }

      # 내부 루프 둘레(인치)
      per_in = 0.0
      faces.each do |f|
        f.loops.each do |lp|
          next if lp.outer?
          lp.edges.each do |e|
            sp = t * e.start.position
            ep = t * e.end.position
            per_in += sp.distance(ep)
          end
        end
      end

      # 스팬으로 W/H (선택 세트의 모든 꼭짓점을 월드좌표로 변환 후 X/Z extents)
      xs, zs = [], []
      faces.each do |f|
        f.vertices.each do |v|
          p = t * v.position
          xs << p.x; zs << p.z
        end
      end
      w_m = (xs.max - xs.min).abs * length_scale
      h_m = (zs.max - zs.min).abs * length_scale

      sets << { tag: tag, area_m2: a_in2 * area_scale, per_in: per_in, w_m: w_m, h_m: h_m }
    end

    # 둘 다 없으면 0 리턴
    return { area_m2: 0.0, per_in: 0.0, w_m: 0.0, h_m: 0.0 } if sets.empty?

    # 면적이 더 큰 세트를 채택
    sets.max_by { |s| s[:area_m2] }
  end

  # 모델 트리에서 Face 를 재귀 탐색(그룹/컴포넌트 내부 포함)
  def self.find_faces(entity, &block)
    if entity.is_a?(Sketchup::Group) || entity.is_a?(Sketchup::ComponentInstance)
      entity.definition.entities.each { |e| find_faces(e, &block) }
    elsif entity.is_a?(Sketchup::Face)
      yield entity
    elsif entity.respond_to?(:each)
      entity.each { |e| find_faces(e, &block) }
    end
  end

  # (v1.2) 이름에서 자재 코드 추출. aa_ 이름은 레거시 패스 소유 → 코드 없음 취급.
  def self._mat_code_of(name)
    s = name.to_s
    return nil if s.start_with?('aa_')
    m = MAT_CODE_RE.match(s)
    m && m[1]
  end

  # (v1.2) 이름에서 [코드] 태그 제거한 표시명
  def self._strip_code_tag(name)
    name.to_s.sub(MAT_CODE_RE, '').gsub(/\s{2,}/, ' ').strip
  end

  # (v1.2) 코드 자재 집계 워커 — 변환 누적(스케일 그룹 정확) + 상속 머티리얼(렌더와 동일 규칙).
  #   acc[:area]  {code => m²}   앞면 기준 면적
  #   acc[:qty]   {code => n}    코드 컴포넌트/그룹 수량 (서브트리는 하나의 제품으로 취급 → 미하강)
  #   acc[:name]  {code => 표시명(첫 발견)}
  #   acc[:back]  뒷면에만 코드 자재가 칠해진 면 수(미집계 경고용)
  def self.walk_coded(entities, tr, inherited, acc)
    entities.each do |e|
      if e.is_a?(Sketchup::Face)
        front = e.material || inherited
        code  = front && _mat_code_of(front.name)
        if code
          acc[:name][code] ||= _strip_code_tag(front.display_name)
          acc[:area][code] = (acc[:area][code] || 0.0) + e.area(tr) * 0.00064516
        else
          back = e.back_material
          acc[:back] += 1 if back && _mat_code_of(back.name)
        end
      elsif e.is_a?(Sketchup::Group) || e.is_a?(Sketchup::ComponentInstance)
        dname = e.definition.name.to_s
        code  = _mat_code_of(dname)
        if code
          acc[:name][code] ||= _strip_code_tag(dname)
          acc[:qty][code] = (acc[:qty][code] || 0) + 1
        else
          walk_coded(e.definition.entities, tr * e.transformation, e.material || inherited, acc)
        end
      end
    end
  end

  # ========================
  # 집계 (공용) — 사람용 CSV("견적 산출")와 앱용 CSV("앱으로 내보내기")가 함께 사용
  # ========================
  # 반환: rows 배열. 각 행은 두 가지 표현을 함께 담는다.
  #   :cat_h/:name_h  → 사람용 6열 CSV 재조립용(기존 출력과 100% 동일하게 유지)
  #   :category/:name/:spec → 앱(DLP-TAKEOFF v1)용 분리 필드
  #   :qty/:unit/:alt_qty/:alt_unit → 주수량/보조수량
  def self.collect_rows
    model = Sketchup.active_model

    area_scale   = 0.00064516   # inch² → m²
    length_scale = 0.0254       # inch  → m

    # 기본 집계
    area_total     = Hash.new(0.0)
    length_total   = Hash.new(0.0)  # aa_len_ 재질+높이별
    quantity_total = Hash.new(0)

    # 추가 집계
    insul_total          = Hash.new(0.0)  # XPS 앞면 면적(두께별)
    intwall_back_total   = Hash.new(0.0)  # 가벽 뒷면 면적(스펙별)
    stud_len_total_spec  = Hash.new(0.0)  # 구조재 길이(스펙별)
    stud_qty_total_spec  = Hash.new(0)    # 구조재 본수(스펙별)
    stud_len_total_type  = Hash.new(0.0)  # 구조재 길이(다루끼/투바이)
    stud_qty_total_type  = Hash.new(0)    # 구조재 본수(다루끼/투바이)
    gypsum_area_total    = Hash.new(0.0)  # 석고 총면적
    gypsum_sheet_total   = Hash.new(0)    # 석고 장수
    plywood_area_total   = Hash.new(0.0)  # 합판 총면적
    plywood_sheet_total  = Hash.new(0)    # 합판 장수

    # 기준
    stud_spacing_wall = 0.45         # 간격 450mm 고정
    gypsum_sheet_m2   = 1.62         # 3×6
    insul_sheet_m2    = 1.62         # 900×1800
    plywood_sheet_m2  = 1.22 * 2.44  # 4×8

    # --- 'aa_' 재질 면적(기존) ---
    self.find_faces(model.entities) do |face|
      mat = face.material
      next unless mat && mat.name.start_with?('aa_')
      area_total[mat.name] += face.area.to_f * area_scale
    end

    # --- aa_len_ : 재질+높이별 길이 + 2.4m 본수 ---
    model.entities.grep(Sketchup::ComponentInstance).each do |inst|
      defn = inst.definition
      name = defn.name.to_s
      next unless name.start_with?('aa_len_')

      len_m = AndoEstimator25._lenx_m_by_projection(inst, length_scale)

      fin = if inst.material
              inst.material.display_name
            else
              (inst.get_attribute('dynamic_attributes','Material') ||
               inst.get_attribute('dynamic_attributes','material') || '').to_s
            end

      lenz_in = inst.get_attribute('dynamic_attributes', 'lenz') ||
                defn.bounds.height * inst.transformation.zscale.abs
      h_mm = (lenz_in.to_f * 25.4).round

      key = "#{name} (#{fin}; H#{h_mm})"
      length_total[key] += len_m
    end

    # --- aa_insul* : 앞면(XZ) 면적(두께별) ---
    model.entities.grep(Sketchup::ComponentInstance).each do |inst|
      defn = inst.definition
      raw  = defn.name.to_s
      next unless raw.start_with?('aa_insul')

      base = raw.sub(/#\d+$/,'')
      leny_in = inst.get_attribute('dynamic_attributes','leny') ||
                defn.bounds.depth * inst.transformation.yscale.abs
      thick_mm = (leny_in.to_f * 25.4).round

      front_y = defn.bounds.min.y
      tol = 0.001
      a_in2 = 0.0
      defn.entities.grep(Sketchup::Face).each do |f|
        on_front = f.vertices.all? { |v| (v.position.y - front_y).abs <= tol }
        a_in2 += f.area(inst.transformation) if on_front
      end
      key = "#{base}_t#{thick_mm}"
      insul_total[key] += a_in2 * area_scale
    end

    # --- aa_INTwall : 스펙별 면적 + 구조재 + 보드 ---
    model.entities.grep(Sketchup::ComponentInstance).each do |inst|
      defn = inst.definition
      raw  = defn.name.to_s
      base = raw.sub(/#\d+$/,'')
      next unless base.downcase.start_with?('aa_intwall')

      # 스펙 라벨 (두께 기반 복원 우선)
      spec = AndoEstimator25._intwall_spec_string(inst)
      spec = spec.to_s.gsub(',', '·').strip
      key  = spec.empty? ? base : "#{base} (#{spec})"
      info = AndoEstimator25.parse_intwall_spec(spec)

      # 뒷면 후보(maxY/minY) 중 더 큰 면적을 가지는 세트를 선택
      chosen = AndoEstimator25._pick_back_face_set_and_spans(inst, area_scale, length_scale)
      a_back_m2 = chosen[:area_m2]
      w_m       = chosen[:w_m]
      h_m       = chosen[:h_m]
      loop_per_in = chosen[:per_in] # inch

      intwall_back_total[key] += a_back_m2

      # 구조재: 세로본수 + 상/하부 2줄 + 개구부 둘레
      v_cnt = (w_m / stud_spacing_wall).ceil + 1
      stud_len_m = v_cnt * h_m + (2.0 * w_m)
      stud_len_m += loop_per_in * length_scale

      stud_len_total_spec[key]  += stud_len_m
      stud_qty_total_spec[key]  += (stud_len_m / 3.6).ceil
      stud_len_total_type[info[:lumber]] += stud_len_m
      stud_qty_total_type[info[:lumber]] += (stud_len_m / 3.6).ceil

      # 보드 산출(석고/합판)
      gypsum_m2 = a_back_m2 * info[:g_layers] * info[:g_sides]   # 2P양면 → ×4
      gypsum_area_total['all']  += gypsum_m2
      gypsum_sheet_total['all'] += (gypsum_m2 / gypsum_sheet_m2).ceil

      if info[:ply_layers] > 0
        ply_m2 = a_back_m2 * info[:ply_layers]
        plywood_area_total['all']  += ply_m2
        plywood_sheet_total['all'] += (ply_m2 / plywood_sheet_m2).ceil
      end
    end

    # --- aa_qty_ ---
    model.entities.grep(Sketchup::ComponentInstance).each do |inst|
      name = inst.definition.name
      next unless name.start_with?('aa_qty_')
      quantity_total[name] += 1
    end

    # --- (v1.2) 자재 코드([WD-####]/[PT:DE:…] 등) — 변환 누적 재귀 집계 ---
    coded = { area: {}, qty: {}, name: {}, back: 0 }
    walk_coded(model.entities, Geom::Transformation.new, nil, coded)
    @coded_back_faces = coded[:back]

    # ========================
    # rows 조립 (기존 CSV 출력 순서 그대로)
    # ========================
    rows = []

    area_total.each do |name, v|
      rows << { cat_h: '면적', name_h: name,
                category: '면적', name: name, spec: '',
                qty: v.round(2), unit: 'm²', alt_qty: nil, alt_unit: nil }
    end

    insul_total.each do |key, v|
      sheets = (v / insul_sheet_m2).ceil
      base, thick = (key =~ /^(.*)_t(\d+)$/) ? [$1, $2] : [key, nil]
      rows << { cat_h: '면적(단열_앞면)', name_h: key,
                category: '면적(단열)', name: base, spec: (thick ? "#{thick}T" : ''),
                qty: v.round(2), unit: 'm²', alt_qty: sheets, alt_unit: 'EA' }
    end

    intwall_back_total.each do |key, v|
      base, spec = (key =~ /^(.*?) \((.*)\)$/) ? [$1, $2] : [key, '']
      rows << { cat_h: '면적(가벽_뒷면)', name_h: key,
                category: '면적(가벽)', name: base, spec: spec,
                qty: v.round(2), unit: 'm²', alt_qty: nil, alt_unit: nil }
    end

    length_total.each do |key, v|
      qty_ea = (v / 2.4).ceil
      base, spec = (key =~ /^(.*?) \((.*)\)$/) ? [$1, $2] : [key, '']
      rows << { cat_h: '길이', name_h: key,
                category: '길이', name: base, spec: spec,
                qty: v.round(3), unit: 'm', alt_qty: qty_ea, alt_unit: 'EA' }
    end

    total_stud_len = stud_len_total_spec.values.reduce(0.0, :+)
    total_stud_qty = stud_qty_total_spec.values.reduce(0, :+)
    rows << { cat_h: '구조재(전체)', name_h: 'aa_INTwall',
              category: '구조재', name: '구조재(전체)', spec: '',
              qty: total_stud_len.round(2), unit: 'm', alt_qty: total_stud_qty, alt_unit: 'EA' }

    %w[다루끼 투바이].each do |t|
      len = (stud_len_total_type[t] || 0.0)
      qty = (stud_qty_total_type[t] || 0)
      next if len <= 0.0
      rows << { cat_h: "구조재(#{t})", name_h: 'aa_INTwall',
                category: '구조재', name: "구조재(#{t})", spec: '3.6m 본',
                qty: len.round(2), unit: 'm', alt_qty: qty, alt_unit: 'EA' }
    end

    gy_area = gypsum_area_total['all']  || 0.0
    gy_sht  = gypsum_sheet_total['all'] || 0
    rows << { cat_h: '보드(석고_전체)', name_h: 'aa_INTwall',
              category: '보드', name: '석고보드(전체)', spec: '3×6',
              qty: gy_area.round(2), unit: 'm²', alt_qty: gy_sht, alt_unit: 'EA' }

    ply_area = plywood_area_total['all']  || 0.0
    ply_sht  = plywood_sheet_total['all'] || 0
    if ply_area > 0.0
      rows << { cat_h: '보드(합판5T_전체)', name_h: 'aa_INTwall',
                category: '보드', name: '합판(5T·전체)', spec: '4×8',
                qty: ply_area.round(2), unit: 'm²', alt_qty: ply_sht, alt_unit: 'EA' }
    end

    quantity_total.each do |name, q|
      rows << { cat_h: '수량', name_h: name,
                category: '수량', name: name, spec: '',
                qty: q, unit: 'EA', alt_qty: nil, alt_unit: nil }
    end

    # (v1.2) 자재 코드 행 — :code 가 guid/material_code 로 나가 앱 임포터의 단가 매핑 키가 된다
    coded[:area].keys.sort.each do |code|
      rows << { cat_h: '자재면적', name_h: "[#{code}] #{coded[:name][code]}",
                category: '자재면적', name: coded[:name][code], spec: '',
                qty: coded[:area][code].round(2), unit: 'm²', alt_qty: nil, alt_unit: nil, code: code }
    end
    coded[:qty].keys.sort.each do |code|
      rows << { cat_h: '자재수량', name_h: "[#{code}] #{coded[:name][code]}",
                category: '자재수량', name: coded[:name][code], spec: '',
                qty: coded[:qty][code], unit: 'EA', alt_qty: nil, alt_unit: nil, code: code }
    end

    rows
  end

  # ========================
  # 출력 ① — 견적 산출 (사람용 6열 CSV, 기존과 100% 동일)
  # ========================
  def self.export_estimation
    rows = collect_rows

    output = "구분,이름,값,단위,갯수,단위2\n"
    rows.each do |r|
      case r[:cat_h]
      when '면적', '면적(가벽_뒷면)'
        output += "#{r[:cat_h]},#{r[:name_h]},#{r[:qty]},m²,,\n"
      when '면적(단열_앞면)'
        output += "#{r[:cat_h]},#{r[:name_h]},#{r[:qty]},m²,#{r[:alt_qty]},EA\n"
      when '길이'
        output += "길이,#{r[:name_h]},#{r[:qty]},m,#{r[:alt_qty]},EA\n"
      when /^구조재/
        output += "#{r[:cat_h]},#{r[:name_h]},#{r[:qty]},m,#{r[:alt_qty]},EA\n"
      when /^보드/
        output += "#{r[:cat_h]},#{r[:name_h]},#{r[:qty]},m²,#{r[:alt_qty]},EA\n"
      when '수량'
        output += "수량,#{r[:name_h]},, ,#{r[:qty]},EA\n"
      when '자재면적' # (v1.2) 코드 자재 — 사람용에도 노출(이름의 콤마만 치환)
        output += "자재면적,#{r[:name_h].to_s.gsub(',', ' ')},#{r[:qty]},m²,,\n"
      when '자재수량'
        output += "자재수량,#{r[:name_h].to_s.gsub(',', ' ')},, ,#{r[:qty]},EA\n"
      end
    end

    path = UI.savepanel("CSV로 저장", "", "estimation.csv")
    if path
      File.write(path, "\uFEFF" + output, mode: "w:utf-8")
      UI.messagebox("CSV 저장 완료!")
    end
  rescue => e
    puts "[AndoEstimator25] 견적 산출 오류: #{e.class} — #{e.message}"
    puts e.backtrace.take(5)
    UI.messagebox("견적 산출 중 오류가 발생했습니다.\n#{e.message}\n(Ruby Console에 상세 로그)")
  end

  # ========================
  # 출력 ② — 앱으로 내보내기 (DLP-TAKEOFF v2 CSV(+material_code), interior-cost 앱 임포트용)
  #   · 1행 매직헤더 + 2행 컬럼헤더 + 데이터. 전 필드 RFC4180 인용 → 이름의 콤마/따옴표 안전.
  #   · 단위 정규화 m²→m2. 숫자는 소수점만(천단위 콤마 없음).
  # ========================

  # CSV 필드 인용(RFC4180): 큰따옴표 감싸기 + 내부 큰따옴표 이스케이프
  def self._csv_q(v)
    '"' + v.to_s.gsub('"', '""') + '"'
  end

  def self._app_unit(u)
    u.to_s.gsub('²', '2') # m² → m2 (그 외 그대로)
  end

  # (v1.2) CSV 조립 순수 메서드 — 라이브 스모크 테스트에서 저장 다이얼로그 없이 검증 가능.
  #   v2: 9열(+material_code). 코드 행은 guid=material_code=코드, 레거시 행은 둘 다 빈값(v1 의미 유지).
  def self.build_app_csv(rows)
    model_name = File.basename(Sketchup.active_model.path.to_s, '.skp')
    model_name = 'untitled' if model_name.empty?
    stamp = Time.now.strftime('%Y-%m-%dT%H:%M:%S')

    out = "#DLP-TAKEOFF,v2,exported_at=#{stamp},model=#{model_name.gsub(',', ' ')},plugin=AndoEstimator25/#{VERSION}\n"
    out += "category,name,spec,qty,unit,alt_qty,alt_unit,guid,material_code\n"
    rows.each do |r|
      code = r[:code].to_s
      out += [
        _csv_q(r[:category]),
        _csv_q(r[:name]),
        _csv_q(r[:spec]),
        _csv_q(r[:qty]),
        _csv_q(_app_unit(r[:unit])),
        _csv_q(r[:alt_qty]),
        _csv_q(r[:alt_unit] ? _app_unit(r[:alt_unit]) : ''),
        _csv_q(code),
        _csv_q(code)
      ].join(',') + "\n"
    end
    out
  end

  def self.export_for_app
    rows = collect_rows
    if rows.empty?
      UI.messagebox("내보낼 물량이 없습니다.\n(aa_ 재질/컴포넌트 또는 [WD-0001] 같은 코드 자재가 모델에 있는지 확인하세요)")
      return
    end

    model_name = File.basename(Sketchup.active_model.path.to_s, '.skp')
    model_name = 'untitled' if model_name.empty?
    out = build_app_csv(rows)

    path = UI.savepanel("앱으로 내보내기 (DLP-TAKEOFF CSV)", "", "dlp_takeoff_#{model_name}.csv")
    if path
      File.write(path, "\uFEFF" + out, mode: "w:utf-8")
      coded_n = rows.count { |r| r[:code] }
      back_n  = @coded_back_faces.to_i
      extra  = coded_n > 0 ? "\n코드 자재 #{coded_n}종 포함 — 앱에서 단가 자동 매핑" : ''
      extra += "\n(주의) 뒷면에만 코드 자재가 칠해진 면 #{back_n}개는 미집계 — 앞면에 칠하세요" if back_n > 0
      UI.messagebox("앱용 CSV 저장 완료! (#{rows.length}개 물량)#{extra}\n\n인테리어 현장관리 앱 → 견적 탭 → [물량 불러오기] → [스케치업 CSV 가져오기]에서 이 파일을 선택하세요.")
    end
  rescue => e
    puts "[AndoEstimator25] 앱으로 내보내기 오류: #{e.class} — #{e.message}"
    puts e.backtrace.take(5)
    UI.messagebox("앱으로 내보내기 중 오류가 발생했습니다.\n#{e.message}\n(Ruby Console에 상세 로그)")
  end

  # ========================
  # 툴바
  # ========================
  unless file_loaded?(__FILE__)
    toolbar = UI::Toolbar.new("AndoEstimator25")
    icon_path = File.join(__dir__, "icons", "dollar_icon.png")

    cmd = UI::Command.new("견적 산출") { AndoEstimator25.export_estimation }
    cmd.tooltip = "AndoEstimator 실행"
    cmd.status_bar_text = "SketchUp 모델에서 자재 견적 산출 (사람용 CSV)"
    cmd.small_icon = icon_path
    cmd.large_icon = icon_path
    toolbar.add_item(cmd)

    # (v1.1) 앱으로 내보내기 — interior-cost 앱 견적 임포트용 DLP-TAKEOFF v1 CSV
    cmd_app = UI::Command.new("앱으로 내보내기") { AndoEstimator25.export_for_app }
    cmd_app.tooltip = "앱으로 내보내기 (DLP-TAKEOFF CSV)"
    cmd_app.status_bar_text = "인테리어 현장관리 앱의 견적 물량으로 가져갈 CSV 저장"
    cmd_app.small_icon = icon_path
    cmd_app.large_icon = icon_path
    toolbar.add_item(cmd_app)

    toolbar.restore
    file_loaded(__FILE__)
  end
end
