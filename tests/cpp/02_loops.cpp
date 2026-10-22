#include <iostream>
#include <vector>
using namespace std;

int sum(const vector<int>& v) {
    int s = 0;
    for (int i = 0; i < v.size(); i++) {
        s += v[i];
    }
    return s;
}

int main() {
    vector<int> v = {4, 8, 15, 16, 23, 42};
    v.push_back(1);
    cout << "size " << v.size() << " sum " << sum(v) << endl;
    for (int i = 10; i >= 0; i -= 3) cout << i << " ";
    cout << endl;
    for (int i = 1; i <= 5; ++i) {
        if (i == 3) continue;
        cout << i;
    }
    cout << endl;
    int n = 0;
    while (n < 3) {
        n++;
    }
    do {
        n--;
    } while (n > 0);
    cout << "n=" << n << endl;
    for (auto x : v) {
        if (x % 2 == 0) cout << x << ' ';
    }
    cout << endl;
    for (int i = 0, j = 10; i < j; i += 2, j -= 2) {
        if (i == 4) continue;
        cout << i << "-" << j << endl;
    }
    return 0;
}
