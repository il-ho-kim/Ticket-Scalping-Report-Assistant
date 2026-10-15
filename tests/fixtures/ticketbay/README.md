티켓베이 공개 페이지·데이터 응답 모양을 본뜬 **가상** 자료예요(2026-10-15 실제 구조 기준). 공연·판매글·가격은 모두 지어낸 것이에요.
- `search-*.html`: `/search?keyword=` 페이지 (`__NEXT_DATA__`의 `searchObj`)
- `category-990001.html`: `/product/990001/list/1` 페이지 (`filterItem`: 회차·등급 목록·등급별 정가, 공연 소개글 `contents`: 공식 공연명·기간·공연장)
- `products.json`: `POST /ticketbayApi/product/v1/public/products` 응답 (판매글 목록)
- `view-*.html`: `/product/view/{상품번호}` 페이지, `not-found.html`: 없는 글
판매글 9000000000001이 합성 캡처 `captures/ticketbay.png`와 같은 글이고, 나머지는 가격·구역·날짜가 하나씩 다른 글이에요.
